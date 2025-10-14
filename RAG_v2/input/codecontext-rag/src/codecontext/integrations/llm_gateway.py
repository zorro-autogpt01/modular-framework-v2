
import httpx
from typing import List, Dict, Optional, AsyncIterator
from ..config import settings

class LLMGatewayClient:
    """Client for LLM Gateway API"""
    
    def __init__(self, base_url: str = None):
        self.base_url = base_url or settings.llm_gateway_url
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=60.0)
    
    async def chat(
        self,
        messages: List[Dict],
        model: str = None,
        temperature: float = 0.7,
        max_tokens: int = None,
        stream: bool = False,
        metadata: Dict = None,
        dry_run: bool = False
    ) -> Dict | AsyncIterator[str]:
        """Send chat request to LLM Gateway"""
        
        data = {
            "model": model or settings.llm_gateway_model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
            "metadata": metadata or {},
            "dry_run": dry_run
        }
        
        if max_tokens:
            data["max_tokens"] = max_tokens
        
        if stream:
            return self._stream_chat(data)
        else:
            response = await self.client.post("/api/v1/chat", json=data)
            response.raise_for_status()
            return response.json()
    
    async def _stream_chat(self, data: Dict) -> AsyncIterator[str]:
        """Stream chat response"""
        async with self.client.stream("POST", "/api/v1/chat", json=data) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    yield line[6:]  # Strip "data: " prefix
    
    async def count_tokens(
        self,
        text: str = None,
        messages: List[Dict] = None,
        model: str = None
    ) -> Dict:
        """Count tokens using LLM Gateway"""
        
        data = {"model": model or settings.llm_gateway_model}
        
        if text:
            data["text"] = text
        if messages:
            data["messages"] = messages
        
        response = await self.client.post("/api/tokens", json=data)
        response.raise_for_status()
        return response.json()
    
    async def get_embedding(
        self,
        text: str,
        model: str = "text-embedding-3-small"
    ) -> List[float]:
        """
        Get embedding from LLM Gateway
        
        Note: This requires LLM Gateway to support embeddings API.
        If not available, fall back to local embedder.
        """
        raise NotImplementedError("Embedding endpoint not yet in LLM Gateway")
    
    async def create_conversation(
        self,
        conversation_id: str,
        title: str = None,
        system_prompt: str = None,
        metadata: Dict = None
    ) -> Dict:
        """Create a conversation in LLM Gateway"""
        
        data = {
            "id": conversation_id,
            "title": title,
            "system_prompt": system_prompt,
            "meta": metadata or {}
        }
        
        response = await self.client.post("/api/conversations", json=data)
        response.raise_for_status()
        return response.json()
    
    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        metadata: Dict = None
    ) -> Dict:
        """Add message to conversation"""
        
        data = {
            "role": role,
            "content": content,
            "meta": metadata or {}
        }
        
        response = await self.client.post(
            f"/api/conversations/{conversation_id}/messages",
            json=data
        )
        response.raise_for_status()
        return response.json()
    
    async def get_conversation_messages(
        self,
        conversation_id: str,
        limit: int = 100
    ) -> List[Dict]:
        """Get messages from conversation"""
        
        params = {"limit": limit}
        response = await self.client.get(
            f"/api/conversations/{conversation_id}/messages",
            params=params
        )
        response.raise_for_status()
        data = response.json()
        return data.get("items", [])
    
    async def close(self):
        """Close HTTP client"""
        await self.client.aclose()
