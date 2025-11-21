const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { exec, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const API_PORT = process.env.API_PORT || 3007;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/home/workspace';

// Middleware
app.use(cors());
app.use(bodyParser.json());

// WebSocket connections for real-time updates
const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', workspace: WORKSPACE_DIR }));
});

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// === WORKSPACE MANAGEMENT API ===

// List workspaces
app.get('/api/workspaces', async (req, res) => {
    try {
        const files = await fs.readdir(WORKSPACE_DIR);
        const workspaces = [];
        
        for (const file of files) {
            const stat = await fs.stat(path.join(WORKSPACE_DIR, file));
            if (stat.isDirectory()) {
                workspaces.push({
                    name: file,
                    path: path.join(WORKSPACE_DIR, file),
                    created: stat.birthtime,
                    modified: stat.mtime
                });
            }
        }
        
        res.json({ workspaces });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create workspace
app.post('/api/workspaces', async (req, res) => {
    const { name, gitUrl } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'Workspace name required' });
    }
    
    const workspacePath = path.join(WORKSPACE_DIR, name);
    
    try {
        await fs.mkdir(workspacePath, { recursive: true });
        
        if (gitUrl) {
            // Clone repository if Git URL provided
            await new Promise((resolve, reject) => {
                exec(`git clone ${gitUrl} ${workspacePath}`, (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }
        
        broadcast({ type: 'workspace-created', name, path: workspacePath });
        res.json({ success: true, workspace: workspacePath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Open workspace in VS Code
app.post('/api/workspaces/:name/open', async (req, res) => {
    const { name } = req.params;
    const workspacePath = path.join(WORKSPACE_DIR, name);
    
    try {
        await fs.access(workspacePath);
        broadcast({ type: 'workspace-opened', name, path: workspacePath });
        res.json({ 
            success: true, 
            url: `http://localhost:3006/?folder=${encodeURIComponent(workspacePath)}`
        });
    } catch (error) {
        res.status(404).json({ error: 'Workspace not found' });
    }
});

// === TERMINAL EXECUTION API ===

const terminals = new Map();

app.post('/api/terminal/create', (req, res) => {
    const { workspaceName } = req.body;
    const terminalId = `term-${Date.now()}`;
    const workspacePath = workspaceName ? 
        path.join(WORKSPACE_DIR, workspaceName) : WORKSPACE_DIR;
    
    const term = spawn('/bin/bash', [], {
        cwd: workspacePath,
        env: { ...process.env, TERM: 'xterm-256color' }
    });
    
    terminals.set(terminalId, term);
    
    term.stdout.on('data', (data) => {
        broadcast({ 
            type: 'terminal-output', 
            terminalId, 
            data: data.toString() 
        });
    });
    
    term.stderr.on('data', (data) => {
        broadcast({ 
            type: 'terminal-error', 
            terminalId, 
            data: data.toString() 
        });
    });
    
    term.on('exit', (code) => {
        terminals.delete(terminalId);
        broadcast({ type: 'terminal-exit', terminalId, code });
    });
    
    res.json({ terminalId });
});

app.post('/api/terminal/:id/exec', (req, res) => {
    const { id } = req.params;
    const { command } = req.body;
    
    const term = terminals.get(id);
    if (!term) {
        return res.status(404).json({ error: 'Terminal not found' });
    }
    
    term.stdin.write(command + '\n');
    res.json({ success: true });
});

// === GITHUB INTEGRATION API ===

app.post('/api/github/clone', async (req, res) => {
    const { repoUrl, workspaceName } = req.body;
    
    if (!repoUrl || !workspaceName) {
        return res.status(400).json({ error: 'Repository URL and workspace name required' });
    }
    
    try {
        // Call GitHub Hub module API
        const githubResponse = await fetch('http://github-hub-module:3005/api/config');
        const githubConfig = await githubResponse.json();
        
        const workspacePath = path.join(WORKSPACE_DIR, workspaceName);
        await fs.mkdir(workspacePath, { recursive: true });
        
        await new Promise((resolve, reject) => {
            exec(`git clone ${repoUrl} ${workspacePath}`, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        
        broadcast({ type: 'repo-cloned', workspace: workspaceName, repo: repoUrl });
        res.json({ success: true, workspace: workspacePath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === LLM INTEGRATION API ===

app.post('/api/llm/assist', async (req, res) => {
    const { code, question, context } = req.body;
    
    try {
        // Call LLM Chat module API
        const llmResponse = await fetch('http://llm-chat-module:3004/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'openai',
                baseUrl: 'https://api.openai.com',
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: 'You are a coding assistant integrated with VS Code.' },
                    { role: 'user', content: `Context:\n${context}\n\nCode:\n${code}\n\nQuestion: ${question}` }
                ],
                stream: false
            })
        });
        
        const result = await llmResponse.json();
        res.json({ suggestion: result.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === FILE OPERATIONS API ===

app.get('/api/files/*', async (req, res) => {
    const filePath = path.join(WORKSPACE_DIR, req.params[0]);
    
    try {
        const stat = await fs.stat(filePath);
        
        if (stat.isDirectory()) {
            const files = await fs.readdir(filePath);
            const items = [];
            
            for (const file of files) {
                const itemPath = path.join(filePath, file);
                const itemStat = await fs.stat(itemPath);
                items.push({
                    name: file,
                    type: itemStat.isDirectory() ? 'directory' : 'file',
                    size: itemStat.size,
                    modified: itemStat.mtime
                });
            }
            
            res.json({ type: 'directory', items });
        } else {
            const content = await fs.readFile(filePath, 'utf-8');
            res.json({ type: 'file', content });
        }
    } catch (error) {
        res.status(404).json({ error: 'File not found' });
    }
});

app.put('/api/files/*', async (req, res) => {
    const filePath = path.join(WORKSPACE_DIR, req.params[0]);
    const { content } = req.body;
    
    try {
        await fs.writeFile(filePath, content, 'utf-8');
        broadcast({ type: 'file-saved', path: filePath });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === WORKFLOW AUTOMATION API ===

app.post('/api/workflows/run', async (req, res) => {
    const { workflow, workspace } = req.body;
    const workspacePath = path.join(WORKSPACE_DIR, workspace);
    
    const workflows = {
        'test': 'npm test',
        'build': 'npm run build',
        'lint': 'npm run lint',
        'format': 'prettier --write .',
        'docker-build': 'docker build -t app .',
        'git-status': 'git status',
        'git-pull': 'git pull origin main'
    };
    
    const command = workflows[workflow];
    if (!command) {
        return res.status(400).json({ error: 'Unknown workflow' });
    }
    
    exec(command, { cwd: workspacePath }, (error, stdout, stderr) => {
        if (error) {
            res.status(500).json({ error: error.message, stderr });
        } else {
            broadcast({ type: 'workflow-completed', workflow, output: stdout });
            res.json({ success: true, output: stdout });
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', workspace: WORKSPACE_DIR });
});

server.listen(API_PORT, () => {
    console.log(`OpenVSCode API server running on port ${API_PORT}`);
});