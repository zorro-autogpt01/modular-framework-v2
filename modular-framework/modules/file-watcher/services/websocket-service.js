// WebSocket Service for Real-time Updates
const WebSocket = require('ws');

class WebSocketService {
  constructor(server) {
    this.wss = new WebSocket.Server({ server });
    this.clients = new Map(); // connection_id:repo_name -> Set of WebSocket clients
    
    this.wss.on('connection', (ws, req) => {
      console.log('WebSocket client connected');
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleMessage(ws, data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });
      
      ws.on('close', () => {
        this.removeClient(ws);
        console.log('WebSocket client disconnected');
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }
  
  handleMessage(ws, data) {
    const { type, connection_id, repo_name } = data;
    
    if (type === 'subscribe' && connection_id && repo_name) {
      const key = `${connection_id}:${repo_name}`;
      
      if (!this.clients.has(key)) {
        this.clients.set(key, new Set());
      }
      
      this.clients.get(key).add(ws);
      ws.repoKey = key;
      
      console.log(`Client subscribed to ${key}`);
      
      ws.send(JSON.stringify({
        type: 'subscribed',
        connection_id,
        repo_name
      }));
    }
  }
  
  removeClient(ws) {
    if (ws.repoKey && this.clients.has(ws.repoKey)) {
      this.clients.get(ws.repoKey).delete(ws);
      
      if (this.clients.get(ws.repoKey).size === 0) {
        this.clients.delete(ws.repoKey);
      }
    }
  }
  
  // Broadcast snapshot update to subscribed clients
  broadcastSnapshot(connection_id, repo_name, snapshot) {
    const key = `${connection_id}:${repo_name}`;
    const clients = this.clients.get(key);
    
    if (!clients || clients.size === 0) return;
    
    const message = JSON.stringify({
      type: 'snapshot',
      data: snapshot
    });
    
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
    
    console.log(`Broadcasted snapshot to ${clients.size} client(s) for ${key}`);
  }
  
  // Broadcast batch update
  broadcastBatch(connection_id, repo_name, batch) {
    const key = `${connection_id}:${repo_name}`;
    const clients = this.clients.get(key);
    
    if (!clients || clients.size === 0) return;
    
    const message = JSON.stringify({
      type: 'batch',
      data: batch
    });
    
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
    
    console.log(`Broadcasted batch to ${clients.size} client(s) for ${key}`);
  }
}

module.exports = WebSocketService;