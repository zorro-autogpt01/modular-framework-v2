// modules/ssh-terminal/server.js
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store active SSH connections
const connections = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', connections: connections.size });
});

app.post('/api/connect', (req, res) => {
    const { host, port, username, password } = req.body;
    
    // Validate input
    if (!host || !username) {
        return res.status(400).json({ error: 'Host and username are required' });
    }
    
    res.json({ 
        status: 'connection_initiated',
        connectionId: `${username}@${host}:${port || 22}`
    });
});

app.get('/api/info', (req, res) => {
    res.json({
        module: 'ssh-terminal',
        version: '1.0.0',
        capabilities: ['ssh', 'sftp', 'terminal'],
        status: 'ready'
    });
});

// WebSocket connection for real-time terminal
wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');
    
    let sshClient = null;
    let stream = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'connect':
                    handleSSHConnection(ws, data.config);
                    break;
                    
                case 'command':
                    if (stream) {
                        stream.write(data.command + '\n');
                    }
                    break;
                    
                case 'resize':
                    if (stream) {
                        stream.setWindow(data.rows, data.cols);
                    }
                    break;
                    
                case 'disconnect':
                    if (sshClient) {
                        sshClient.end();
                    }
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });
    
    ws.on('close', () => {
        console.log('WebSocket connection closed');
        if (sshClient) {
            sshClient.end();
        }
    });
    
    function handleSSHConnection(ws, config) {
        sshClient = new Client();
        
        sshClient.on('ready', () => {
            console.log('SSH connection established');
            
            ws.send(JSON.stringify({
                type: 'connected',
                message: `Connected to ${config.host}`
            }));
            
            sshClient.shell((err, shellStream) => {
                if (err) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err.message
                    }));
                    return;
                }
                
                stream = shellStream;
                
                stream.on('data', (data) => {
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: data.toString()
                    }));
                });
                
                stream.on('close', () => {
                    ws.send(JSON.stringify({
                        type: 'disconnected',
                        message: 'SSH connection closed'
                    }));
                });
            });
        });
        
        sshClient.on('error', (err) => {
            console.error('SSH connection error:', err);
            ws.send(JSON.stringify({
                type: 'error',
                message: err.message
            }));
        });
        
        // Connect to SSH server
        sshClient.connect({
            host: config.host,
            port: config.port || 22,
            username: config.username,
            password: config.password,
            // For key-based auth:
            // privateKey: config.privateKey
        });
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`SSH Terminal Module running on port ${PORT}`);
});
