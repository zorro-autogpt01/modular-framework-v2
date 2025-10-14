# src/codecontext/core/embedder.py
from typing import List, Dict, Protocol
import httpx
import os
from abc import ABC, abstractmethod
from sentence_transformers import SentenceTransformer
import numpy as np
from ..integrations.llm_gateway import LLMGatewayClient
from ..config import settings

class Embedder:
    def __init__(self, model_name: str = "microsoft/codebert-base"):
        """Initialize embedder with specified model"""
        # For CodeBERT
        self.model = SentenceTransformer(model_name)
        self.dimension = self.model.get_sentence_embedding_dimension()
    
    def embed_text(self, text: str) -> List[float]:
        """Generate embedding for single text"""
        embedding = self.model.encode(text, convert_to_numpy=True)
        return embedding.tolist()
    
    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for multiple texts (more efficient)"""
        embeddings = self.model.encode(texts, convert_to_numpy=True, batch_size=32)
        return embeddings.tolist()
    
    def embed_code_entity(self, entity: Dict) -> Dict:
        """Generate embedding for a code entity (function/class)"""
        # Combine name, docstring, and code for better representation
        text_parts = []
        
        if 'name' in entity:
            text_parts.append(f"Function: {entity['name']}")
        
        if 'docstring' in entity and entity['docstring']:
            text_parts.append(entity['docstring'])
        
        if 'code' in entity:
            # Include actual code (truncated if too long)
            code = entity['code'][:1000]  # Limit to 1000 chars
            text_parts.append(code)
        
        combined_text = "\n".join(text_parts)
        embedding = self.embed_text(combined_text)
        
        return {
            **entity,
            'embedding': embedding,
            'embedding_text': combined_text[:200]  # Store sample for debugging
        }


class LLMGatewayEmbedder:
    """
    Embedder that uses your LLM Gateway's embeddings endpoint
    """
    def __init__(
        self,
        gateway_url: str = None,
        model: str = "text-embedding-3-small",
        model_id: int = None,
        model_key: str = None,
        dimensions: int = None
    ):
        """
        Initialize LLM Gateway embedder
        
        Args:
            gateway_url: Base URL of LLM Gateway (e.g., http://llm-gateway:3010)
            model: Model name (default: text-embedding-3-small)
            model_id: Optional model ID from gateway config
            model_key: Optional model key from gateway config
            dimensions: Optional dimensions for supported models
        """
        self.gateway_url = gateway_url or os.getenv(
            "LLM_GATEWAY_URL", 
            "http://llm-gateway:3010"
        )
        self.model = model
        self.model_id = model_id
        self.model_key = model_key
        self.dimensions = dimensions
        
        # Create persistent HTTP client for connection pooling
        self.client = httpx.AsyncClient(
            timeout=60.0,
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
        )
    
    async def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for a batch of texts
        
        Args:
            texts: List of text strings to embed
            
        Returns:
            List of embedding vectors (each is a List[float])
        """
        if not texts:
            return []
        
        # Prepare request body
        body = {
            "input": texts,
            "model": self.model
        }
        
        # Add optional parameters
        if self.model_id:
            body["model_id"] = self.model_id
        if self.model_key:
            body["model_key"] = self.model_key
        if self.dimensions:
            body["dimensions"] = self.dimensions
        
        try:
            # Call LLM Gateway embeddings endpoint
            response = await self.client.post(
                f"{self.gateway_url}/api/embeddings",
                json=body
            )
            response.raise_for_status()
            
            result = response.json()
            
            # Extract embeddings from OpenAI-compatible format
            embeddings = [item["embedding"] for item in result["data"]]
            
            return embeddings
            
        except httpx.HTTPError as e:
            raise RuntimeError(f"Failed to generate embeddings via LLM Gateway: {e}")
    
    async def embed_text(self, text: str) -> List[float]:
        """
        Generate embedding for a single text
        
        Args:
            text: Text string to embed
            
        Returns:
            Embedding vector as List[float]
        """
        embeddings = await self.embed_texts([text])
        return embeddings[0] if embeddings else []
    
    async def close(self):
        """Close the HTTP client"""
        await self.client.aclose()
    
    async def __aenter__(self):
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()


class OpenAIEmbedder:
    """
    Direct OpenAI embedder (fallback/alternative)
    """
    def __init__(self, model: str = "text-embedding-3-small"):
        import openai
        self.model = model
        self.client = openai.AsyncOpenAI()
    
    async def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings using OpenAI directly"""
        if not texts:
            return []
        
        response = await self.client.embeddings.create(
            model=self.model,
            input=texts
        )
        
        return [item.embedding for item in response.data]
    
    async def embed_text(self, text: str) -> List[float]:
        """Generate embedding for single text"""
        embeddings = await self.embed_texts([text])
        return embeddings[0] if embeddings else []