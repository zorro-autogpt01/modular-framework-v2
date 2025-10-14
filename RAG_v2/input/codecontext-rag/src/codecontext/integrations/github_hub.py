# src/codecontext/integrations/github_hub.py

import httpx
from typing import List, Dict, Optional
from ..config import settings

class GitHubHubClient:
    """Client for GitHub Hub API"""
    
    def __init__(self, base_url: str = None, conn_id: str = None):
        self.base_url = base_url or settings.github_hub_url
        self.conn_id = conn_id or settings.github_default_conn
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
    
    async def list_connections(self) -> Dict:
        """List available GitHub connections"""
        response = await self.client.get("/api/connections")
        response.raise_for_status()
        return response.json()
    
    async def get_tree(
        self, 
        path: str = "", 
        branch: str = None, 
        recursive: bool = True,
        conn_id: str = None
    ) -> Dict:
        """Get repository tree (file listing)"""
        params = {
            "path": path,
            "recursive": recursive,
            "conn_id": conn_id or self.conn_id
        }
        if branch:
            params["branch"] = branch
        
        response = await self.client.get("/api/tree", params=params)
        response.raise_for_status()
        return response.json()
    
    async def get_file(
        self, 
        path: str, 
        branch: str = None,
        conn_id: str = None
    ) -> Dict:
        """Get file content (decoded)"""
        params = {
            "path": path,
            "conn_id": conn_id or self.conn_id
        }
        if branch:
            params["branch"] = branch
        
        response = await self.client.get("/api/file", params=params)
        response.raise_for_status()
        return response.json()
    
    async def get_branches(self, conn_id: str = None) -> List[str]:
        """List branches for a connection"""
        params = {"conn_id": conn_id or self.conn_id}
        response = await self.client.get("/api/branches", params=params)
        response.raise_for_status()
        data = response.json()
        return data.get("branches", [])
    
    async def list_commits(
        self,
        sha: str = None,
        path: str = None,
        per_page: int = 100,
        conn_id: str = None
    ) -> List[Dict]:
        """List commits"""
        params = {
            "conn_id": conn_id or self.conn_id,
            "per_page": per_page
        }
        if sha:
            params["sha"] = sha
        if path:
            params["path"] = path
        
        response = await self.client.get("/api/commits", params=params)
        response.raise_for_status()
        return response.json()
    
    async def create_pr(
        self,
        title: str,
        head: str,
        base: str,
        body: str = None,
        draft: bool = False,
        conn_id: str = None
    ) -> Dict:
        """Create a pull request"""
        params = {"conn_id": conn_id or self.conn_id}
        data = {
            "title": title,
            "head": head,
            "base": base,
            "body": body,
            "draft": draft
        }
        
        response = await self.client.post("/api/pr", params=params, json=data)
        response.raise_for_status()
        return response.json()
    
    async def batch_commit(
        self,
        branch: str,
        message: str,
        changes: List[Dict],
        conn_id: str = None
    ) -> Dict:
        """Create a batch commit with multiple file changes"""
        params = {"conn_id": conn_id or self.conn_id}
        data = {
            "branch": branch,
            "message": message,
            "changes": changes
        }
        
        response = await self.client.post("/api/batch/commit", params=params, json=data)
        response.raise_for_status()
        return response.json()
    
    async def close(self):
        """Close the HTTP client"""
        await self.client.aclose()