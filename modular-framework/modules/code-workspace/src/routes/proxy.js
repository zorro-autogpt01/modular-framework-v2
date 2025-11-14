const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const GITHUB_HUB_URL = process.env.GITHUB_HUB_URL || 'http://github-hub-module:3002/api';

console.log('🔧 Proxy routes loaded, GitHub Hub URL:', GITHUB_HUB_URL);

// Proxy to github-hub: List all connections
router.get('/github-hub/connections', async (req, res) => {
    console.log('📥 Received request to /github-hub/connections');
    try {
        const url = `${GITHUB_HUB_URL}/connections`;
        console.log('🔗 Fetching from:', url);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error('❌ GitHub Hub responded with:', response.status);
            return res.status(response.status).json({ 
                error: 'Failed to fetch connections from github-hub' 
            });
        }
        
        const data = await response.json();
        console.log('✅ Successfully fetched connections:', data.connections?.length || 0);
        res.json(data);
    } catch (error) {
        console.error('❌ Error fetching connections:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy to github-hub: Get connection details
router.get('/github-hub/connections/:connectionId', async (req, res) => {
    const { connectionId } = req.params;
    console.log('📥 Received request for connection:', connectionId);
    
    try {
        const url = `${GITHUB_HUB_URL}/connections/${connectionId}`;
        console.log('🔗 Fetching from:', url);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error('❌ GitHub Hub responded with:', response.status);
            return res.status(response.status).json({ 
                error: 'Failed to fetch connection from github-hub' 
            });
        }
        
        const data = await response.json();
        console.log('✅ Successfully fetched connection:', connectionId);
        res.json(data);
    } catch (error) {
        console.error('❌ Error fetching connection:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy to github-hub: Get branches for a connection
router.get('/github-hub/branches', async (req, res) => {
    const { conn_id } = req.query;
    console.log('📥 Received request for branches, conn_id:', conn_id);
    
    if (!conn_id) {
        return res.status(400).json({ error: 'conn_id query parameter is required' });
    }
    
    try {
        const url = `${GITHUB_HUB_URL}/branches?conn_id=${conn_id}`;
        console.log('🔗 Fetching from:', url);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error('❌ GitHub Hub responded with:', response.status);
            return res.status(response.status).json({ 
                error: 'Failed to fetch branches from github-hub' 
            });
        }
        
        const data = await response.json();
        console.log('✅ Successfully fetched branches');
        res.json(data);
    } catch (error) {
        console.error('❌ Error fetching branches:', error);
        res.status(500).json({ error: error.message });
    }
});

console.log('✅ Proxy router configured with routes:');
console.log('   - GET /github-hub/connections');
console.log('   - GET /github-hub/connections/:connectionId');
console.log('   - GET /github-hub/branches');

module.exports = router;