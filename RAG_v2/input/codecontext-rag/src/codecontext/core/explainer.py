# src/codecontext/core/explainer.py

from typing import List, Dict
from ..integrations.llm_gateway import LLMGatewayClient
from ..config import settings

class Explainer:
    """Generate human-readable explanations for recommendations"""
    
    def __init__(self):
        self.llm_client = LLMGatewayClient() if settings.llm_gateway_enabled else None
    
    async def explain_recommendation(
        self,
        file_path: str,
        query: str,
        scores: Dict[str, float],
        file_metadata: Dict
    ) -> str:
        """Generate detailed explanation using LLM"""
        
        if not self.llm_client:
            return self._simple_explanation(file_path, scores)
        
        # Build context for LLM
        context = f"""
File: {file_path}
Language: {file_metadata.get('language', 'unknown')}
Functions: {', '.join(file_metadata.get('functions', [])[:5])}
Classes: {', '.join(file_metadata.get('classes', [])[:5])}

Scores:
- Semantic similarity: {scores.get('semantic', 0):.2f}
- Dependency centrality: {scores.get('dependency', 0):.2f}
- Co-modification history: {scores.get('history', 0):.2f}
- Recency: {scores.get('recency', 0):.2f}

User Query: {query}
"""
        
        messages = [
            {
                "role": "system",
                "content": "You are a code analysis assistant. Explain why a file is relevant for implementing a feature. Be concise and specific."
            },
            {
                "role": "user",
                "content": f"Why is this file relevant?\n\n{context}"
            }
        ]
        
        try:
            response = await self.llm_client.chat(
                messages=messages,
                temperature=0.3,
                max_tokens=150
            )
            
            return response.get("content", self._simple_explanation(file_path, scores))
        
        except Exception as e:
            print(f"LLM explanation failed: {e}")
            return self._simple_explanation(file_path, scores)
    
    def _simple_explanation(self, file_path: str, scores: Dict) -> str:
        """Fallback to simple explanation"""
        parts = []
        
        if scores.get('semantic', 0) > 0.6:
            parts.append("high semantic similarity")
        if scores.get('dependency', 0) > 0.6:
            parts.append("central in dependency graph")
        if scores.get('history', 0) > 0.6:
            parts.append("frequently modified with similar features")
        
        if parts:
            return f"Relevant due to {', '.join(parts)}"
        else:
            return "Potentially relevant to your query"
    
    async def close(self):
        if self.llm_client:
            await self.llm_client.close()