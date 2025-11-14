const WebSocket = require('ws');
const RedisService = require('./redis');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map();
  }

  initialize(wss) {
    this.wss = wss;

    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      
      // Store client info
      this.clients.set(clientId, {
        ws,
        subscriptions: new Set(),
        connectionTime: new Date(),
        ip: req.socket.remoteAddress
      });

      console.log(`WebSocket client connected: ${clientId}`);

      // Send welcome message
      this.sendToClient(clientId, {
        type: 'connection',
        data: {
          clientId,
          connected: true,
          timestamp: new Date().toISOString()
        }
      });

      // Handle messages
      ws.on('message', (message) => {
        this.handleMessage(clientId, message);
      });

      // Handle close
      ws.on('close', () => {
        console.log(`WebSocket client disconnected: ${clientId}`);
        this.clients.delete(clientId);
      });

      // Handle error
      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
      });

      // Ping to keep connection alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
    });

    // Subscribe to Redis events
    this.subscribeToRedisEvents();
  }

  generateClientId() {
    return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  handleMessage(clientId, message) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'subscribe':
          this.handleSubscribe(clientId, data);
          break;
        
        case 'unsubscribe':
          this.handleUnsubscribe(clientId, data);
          break;
        
        case 'ping':
          this.sendToClient(clientId, { type: 'pong', timestamp: Date.now() });
          break;
        
        case 'repo:watch':
          this.handleRepoWatch(clientId, data);
          break;
        
        case 'file:watch':
          this.handleFileWatch(clientId, data);
          break;
        
        default:
          console.log(`Unknown message type from ${clientId}:`, data.type);
      }
    } catch (error) {
      console.error(`Error handling message from ${clientId}:`, error);
    }
  }

  handleSubscribe(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && data.channel) {
      client.subscriptions.add(data.channel);
      this.sendToClient(clientId, {
        type: 'subscribed',
        data: { channel: data.channel }
      });
    }
  }

  handleUnsubscribe(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && data.channel) {
      client.subscriptions.delete(data.channel);
      this.sendToClient(clientId, {
        type: 'unsubscribed',
        data: { channel: data.channel }
      });
    }
  }

  handleRepoWatch(clientId, data) {
    const { connection_id, repo_name } = data;
    const channel = `repo:${connection_id}:${repo_name}`;
    this.handleSubscribe(clientId, { channel });
  }

  handleFileWatch(clientId, data) {
    const { connection_id, repo_name, file } = data;
    const channel = `file:${connection_id}:${repo_name}:${file}`;
    this.handleSubscribe(clientId, { channel });
  }

  async subscribeToRedisEvents() {
    // Subscribe to workspace events
    await RedisService.subscribe('workspace:events', (message) => {
      const event = JSON.parse(message);
      this.broadcast(event);
    });

    // Subscribe to file change events
    await RedisService.subscribe('file:changes', (message) => {
      const event = JSON.parse(message);
      this.broadcastToChannel(`repo:${event.connection_id}:${event.repo_name}`, event);
    });

    // Subscribe to git events
    await RedisService.subscribe('git:events', (message) => {
      const event = JSON.parse(message);
      this.broadcastToChannel(`repo:${event.connection_id}:${event.repo_name}`, event);
    });
  }

  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  broadcast(message) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((client, clientId) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageStr);
      }
    });
  }

  broadcastToChannel(channel, message) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((client, clientId) => {
      if (client.subscriptions.has(channel) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageStr);
      }
    });
  }

  broadcastToRepo(connection_id, repo_name, message) {
    const channel = `repo:${connection_id}:${repo_name}`;
    this.broadcastToChannel(channel, message);
  }

  getConnectionStats() {
    return {
      totalClients: this.clients.size,
      clients: Array.from(this.clients.entries()).map(([id, client]) => ({
        id,
        subscriptions: Array.from(client.subscriptions),
        connectionTime: client.connectionTime,
        ip: client.ip
      }))
    };
  }
}

module.exports = new WebSocketService();
