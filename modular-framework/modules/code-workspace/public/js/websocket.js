// WebSocket Service for real-time updates

class WebSocketService {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.listeners = new Map();
        this.subscriptions = new Set();
        this.clientId = null;
        this.isConnecting = false;
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        if (this.isConnecting) {
            return new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });
        }

        this.isConnecting = true;

        return new Promise((resolve, reject) => {
            try {
                const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
                this.ws = new WebSocket(`${wsProto}://${location.host}/api/v1/code-workspace/ws`);

                // Connect to WebSocket server on port 3007
                // this.ws = new WebSocket(`ws://192.168.0.10:3007`);

                this.ws.onopen = () => {
                    console.log('WebSocket connected');
                    this.reconnectAttempts = 0;
                    this.isConnecting = false;
                    this.updateConnectionStatus(true);

                    // Re-subscribe to previous subscriptions
                    this.subscriptions.forEach(channel => {
                        this.send({ type: 'subscribe', channel });
                    });

                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Error parsing WebSocket message:', error);
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('WebSocket error:', error);
                    this.isConnecting = false;
                    this.updateConnectionStatus(false, 'Connection error');
                    reject(error);
                };

                this.ws.onclose = () => {
                    console.log('WebSocket disconnected');
                    this.isConnecting = false;
                    this.updateConnectionStatus(false, 'Disconnected');
                    this.attemptReconnect();
                };

            } catch (error) {
                console.error('Failed to create WebSocket:', error);
                this.isConnecting = false;
                reject(error);
            }
        });
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            this.updateConnectionStatus(false, 'Connection failed');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
        this.updateConnectionStatus(false, 'Reconnecting...');

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.subscriptions.clear();
        this.listeners.clear();
    }

    send(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not connected, queueing message');
            return;
        }

        this.ws.send(JSON.stringify(message));
    }

    handleMessage(message) {
        // Handle system messages
        if (message.type === 'connection') {
            this.clientId = message.data.clientId;
            console.log('Client ID:', this.clientId);
            return;
        }

        // Emit to listeners
        this.emit(message.type, message.data || message);

        // Handle specific message types
        switch (message.type) {
            case 'file:event':
                this.handleFileEvent(message.data);
                break;
            
            case 'repo:add':
            case 'repo:change':
            case 'repo:unlink':
                this.handleRepoEvent(message.data);
                break;
            
            case 'snapshot:created':
            case 'snapshot:deleted':
            case 'snapshot:restored':
                this.handleSnapshotEvent(message.data);
                break;
            
            case 'lock:acquired':
            case 'lock:released':
            case 'lock:extended':
                this.handleLockEvent(message.data);
                break;
            
            case 'git:commit':
            case 'git:push':
            case 'git:pull':
            case 'git:merge':
                this.handleGitEvent(message.data);
                break;
            
            default:
                // Generic event handling
                break;
        }
    }

    handleFileEvent(data) {
        console.log('File event:', data);
        
        // Update UI based on file changes
        if (window.Workspace && window.Workspace.currentRepo) {
            const { connection_id, repo_name } = window.Workspace.currentRepo;
            if (data.connection_id === connection_id && data.repo_name === repo_name) {
                // Refresh file tree or editor if needed
                window.Workspace.handleFileChange(data);
            }
        }
    }

    handleRepoEvent(data) {
        console.log('Repository event:', data);
        
        // Update repository list
        if (window.Repositories) {
            window.Repositories.handleRepoChange(data);
        }
    }

    handleSnapshotEvent(data) {
        console.log('Snapshot event:', data);
        
        // Update history view
        if (window.History) {
            window.History.handleSnapshotChange(data);
        }
    }

    handleLockEvent(data) {
        console.log('Lock event:', data);
        
        // Update file lock indicators
        if (window.Workspace) {
            window.Workspace.handleLockChange(data);
        }
    }

    handleGitEvent(data) {
        console.log('Git event:', data);
        
        // Update git status
        if (window.Workspace) {
            window.Workspace.handleGitEvent(data);
        }
    }

    subscribe(channel) {
        this.subscriptions.add(channel);
        this.send({ type: 'subscribe', channel });
    }

    unsubscribe(channel) {
        this.subscriptions.delete(channel);
        this.send({ type: 'unsubscribe', channel });
    }

    watchRepo(connection_id, repo_name) {
        this.send({
            type: 'repo:watch',
            connection_id,
            repo_name
        });
    }

    watchFile(connection_id, repo_name, file) {
        this.send({
            type: 'file:watch',
            connection_id,
            repo_name,
            file
        });
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    off(event, callback) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }

    emit(event, data) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in event listener for ${event}:`, error);
                }
            });
        }
    }

    updateConnectionStatus(connected, text = null) {
        const statusElement = document.getElementById('ws-status');
        const statusText = document.getElementById('ws-status-text');
        
        if (statusElement) {
            statusElement.classList.toggle('connected', connected);
            statusElement.classList.toggle('error', !connected && this.reconnectAttempts >= this.maxReconnectAttempts);
        }
        
        if (statusText) {
            statusText.textContent = text || (connected ? 'Connected' : 'Disconnected');
        }
    }

    // Heartbeat to keep connection alive
    startHeartbeat() {
        setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.send({ type: 'ping' });
            }
        }, 30000); // Every 30 seconds
    }
}

// Create global instance
window.WS = new WebSocketService();

// Auto-connect on load
document.addEventListener('DOMContentLoaded', () => {
    WS.connect().then(() => {
        WS.startHeartbeat();
    }).catch(error => {
        console.error('Initial WebSocket connection failed:', error);
    });
});
