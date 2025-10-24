# 🆕 NEW FILE
from __future__ import annotations
from typing import Dict, List
import httpx
from loguru import logger
import os

class TokenCounter:
    """Count tokens using LLM Gateway API."""
    
    def __init__(self, llm_gateway_url: str = None):
        self.api_url = llm_gateway_url or os.getenv('LLM_GATEWAY_URL', 'http://localhost:3001')
    
    async def count_tokens(self, text: str) -> int:
        """Count tokens for a single text."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.api_url}/api/tokens/count",
                    json={"text": text},
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()
                return data.get('tokens', 0)
        except Exception as e:
            logger.warning(f"Token counting failed: {e}, using fallback")
            # Fallback: rough estimation
            return len(text) // 4
    
    async def analyze_file(self, path: str, content: str) -> Dict:
        """Analyze a single file."""
        tokens = await self.count_tokens(content)
        lines = content.count('\n') + 1
        chars = len(content)
        
        return {
            "path": path,
            "tokens": tokens,
            "lines": lines,
            "chars": chars,
            "tokens_per_line": round(tokens / lines) if lines > 0 else 0
        }
    
    async def analyze_files(self, files: List[str], get_content_func) -> Dict:
        """Analyze multiple files."""
        results = {}
        total = len(files)
        
        logger.info(f"Counting tokens for {total} files...")
        
        for i, file_path in enumerate(files, 1):
            try:
                content = get_content_func(file_path)
                results[file_path] = await self.analyze_file(file_path, content)
                
                if i % 10 == 0:
                    logger.info(f"Progress: {i}/{total} files")
            except Exception as e:
                logger.warning(f"Failed to analyze {file_path}: {e}")
        
        return {
            "files": results,
            "totals": {
                "tokens": sum(f["tokens"] for f in results.values()),
                "lines": sum(f["lines"] for f in results.values()),
                "chars": sum(f["chars"] for f in results.values())
            }
        }