# src/codecontext/api/websocket.py
from fastapi import WebSocket, WebSocketDisconnect
from typing import Dict, Set
import json
import asyncio
from ..utils.logging import get_logger

logger = get_logger(__name__)


class ConnectionManager:
    def __init__(self):
        # repo_id -> set of WebSocket connections
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        # Global connections (for all repos)
        self.global_connections: Set[WebSocket] = set()
        
    async def connect(self, websocket: WebSocket, repo_id: str = None):
        """Connect a WebSocket client"""
        await websocket.accept()
        
        if repo_id:
            if repo_id not in self.active_connections:
                self.active_connections[repo_id] = set()
            self.active_connections[repo_id].add(websocket)
            logger.info(f"WebSocket connected for repo {repo_id}")
        else:
            self.global_connections.add(websocket)
            logger.info("Global WebSocket connected")
    
    def disconnect(self, websocket: WebSocket, repo_id: str = None):
        """Disconnect a WebSocket client"""
        if repo_id and repo_id in self.active_connections:
            self.active_connections[repo_id].discard(websocket)
            if not self.active_connections[repo_id]:
                del self.active_connections[repo_id]
            logger.info(f"WebSocket disconnected for repo {repo_id}")
        else:
            self.global_connections.discard(websocket)
            logger.info("Global WebSocket disconnected")
    
    async def send_progress(self, repo_id: str, data: dict):
        """Send progress update to all connected clients for a repo"""
        message = json.dumps({
            "type": "progress",
            "repo_id": repo_id,
            "data": data
        })
        
        # Send to repo-specific connections
        if repo_id in self.active_connections:
            disconnected = []
            for connection in self.active_connections[repo_id]:
                try:
                    await connection.send_text(message)
                except Exception as e:
                    logger.error(f"Error sending to WebSocket: {e}")
                    disconnected.append(connection)
            
            # Clean up disconnected
            for conn in disconnected:
                self.active_connections[repo_id].discard(conn)
        
        # Send to global connections
        disconnected = []
        for connection in self.global_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Error sending to global WebSocket: {e}")
                disconnected.append(connection)
        
        for conn in disconnected:
            self.global_connections.discard(conn)
    
    async def send_status(self, repo_id: str, status: str, message: str = None):
        """Send status update"""
        await self.send_progress(repo_id, {
            "status": status,
            "message": message,
            "timestamp": asyncio.get_event_loop().time()
        })
    
    async def send_error(self, repo_id: str, error: str):
        """Send error message"""
        await self.send_progress(repo_id, {
            "status": "error",
            "error": error,
            "timestamp": asyncio.get_event_loop().time()
        })


# Global manager instance
manager = ConnectionManager()