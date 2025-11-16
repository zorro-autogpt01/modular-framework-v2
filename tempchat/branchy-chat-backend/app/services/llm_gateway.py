import httpx
import asyncio
from typing import AsyncIterator
from app.core.config import settings

class LLMGateway:
    def __init__(self):
        self.base = settings.LLM_GATEWAY_BASE_URL.rstrip('/')
        self.token = settings.LLM_GATEWAY_INTERNAL_TOKEN
        self.headers = {"Accept": "application/json"}
        if self.token:
            self.headers["Authorization"] = f"Bearer {self.token}"

    async def list_models(self) -> dict:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(f"{self.base}/api/models")
            r.raise_for_status()
            return r.json()

    async def tokens(self, body: dict) -> dict:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{self.base}/api/tokens", json=body)
            r.raise_for_status()
            return r.json()

    async def chat_json(self, body: dict) -> dict:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(f"{self.base}/api/v1/chat", json=body, headers=self.headers)
            r.raise_for_status()
            return r.json()

    async def chat_sse(self, body: dict) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{self.base}/api/v1/chat", json=body, headers=self.headers) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if line:
                        yield line

llm_gateway = LLMGateway()