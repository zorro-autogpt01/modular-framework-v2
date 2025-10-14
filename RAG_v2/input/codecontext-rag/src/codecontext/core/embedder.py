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
    
    async def embed_texts(self, texts: List[str], max_retries: int = 3) -> List[List[float]]:
        """
        Generate embeddings for a batch of texts with retry logic
        """
        if not texts:
            return []
        
        # Truncate very long texts to avoid token limits
        MAX_CHARS = 8000  # OpenAI limit is ~8000 tokens, roughly 32k chars
        truncated_texts = []
        for text in texts:
            if len(text) > MAX_CHARS:
                truncated_texts.append(text[:MAX_CHARS] + "... [truncated]")
            else:
                truncated_texts.append(text)
        
        body = {
            "input": truncated_texts,
            "model": self.model
        }
        
        if self.model_id:
            body["model_id"] = self.model_id
        if self.model_key:
            body["model_key"] = self.model_key
        if self.dimensions:
            body["dimensions"] = self.dimensions
        
        # Retry logic
        last_error = None
        for attempt in range(max_retries):
            try:
                response = await self.client.post(
                    f"{self.gateway_url}/api/embeddings",
                    json=body,
                    timeout=120.0  # Longer timeout
                )
                response.raise_for_status()
                
                result = response.json()
                embeddings = [item["embedding"] for item in result["data"]]
                
                return embeddings
                
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code == 500:
                    # Log the error details
                    print(f"Embedding attempt {attempt + 1}/{max_retries} failed with 500")
                    print(f"Response: {e.response.text[:500]}")
                    
                    # If this is a text length issue, try splitting
                    if attempt < max_retries - 1 and len(truncated_texts) > 1:
                        print(f"Retrying with smaller batch...")
                        # Split batch in half and retry
                        mid = len(truncated_texts) // 2
                        try:
                            first_half = await self.embed_texts(truncated_texts[:mid], max_retries=1)
                            second_half = await self.embed_texts(truncated_texts[mid:], max_retries=1)
                            return first_half + second_half
                        except Exception as split_error:
                            print(f"Split retry failed: {split_error}")
                    
                    # Wait before retry
                    import asyncio
                    await asyncio.sleep(1 * (attempt + 1))
                else:
                    # Other HTTP errors, don't retry
                    raise
                    
            except httpx.TimeoutException as e:
                last_error = e
                print(f"Embedding attempt {attempt + 1}/{max_retries} timed out")
                if attempt < max_retries - 1:
                    import asyncio
                    await asyncio.sleep(2 * (attempt + 1))
                    
            except Exception as e:
                last_error = e
                print(f"Embedding attempt {attempt + 1}/{max_retries} failed: {e}")
                break
        
        # All retries failed
        raise RuntimeError(f"Failed to generate embeddings after {max_retries} attempts: {last_error}")
    
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

    def embed_code_entity(self, entity: dict) -> dict:
        """Embed a code entity with better error handling"""
        import asyncio
        
        # Build text representation
        text_parts = []
        
        if entity.get('entity_type'):
            text_parts.append(f"Type: {entity['entity_type']}")
        
        if entity.get('name'):
            text_parts.append(f"Name: {entity['name']}")
        
        if entity.get('file_path'):
            text_parts.append(f"File: {entity['file_path']}")
        
        if entity.get('code'):
            # Limit code length aggressively
            code = entity['code'][:3000]  # Max 3000 chars of code
            text_parts.append(f"Code:\n{code}")
        
        if entity.get('language'):
            text_parts.append(f"Language: {entity['language']}")
        
        text = "\n".join(text_parts)
        
        # Sanitize text - remove null bytes and control characters
        import re
        text = re.sub(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]', '', text)
        
        if not text.strip():
            text = f"Empty {entity.get('entity_type', 'entity')}"
        
        # Limit total text length
        MAX_TEXT_LENGTH = 5000
        if len(text) > MAX_TEXT_LENGTH:
            text = text[:MAX_TEXT_LENGTH] + "... [truncated]"
        
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        try:
            embedding = loop.run_until_complete(self.embed_text(text))
        except Exception as e:
            print(f"Warning: Failed to embed {entity.get('id')}: {e}")
            # Return entity without embedding - will be filtered out later
            return entity
        
        # Validate embedding
        if not embedding:
            print(f"Warning: Empty embedding for {entity.get('id')}")
            return entity
        
        if len(embedding) != self.dimensions:
            print(f"Warning: Expected {self.dimensions} dims, got {len(embedding)} for {entity.get('id')}")
            # Pad or truncate
            if len(embedding) < self.dimensions:
                embedding.extend([0.0] * (self.dimensions - len(embedding)))
            else:
                embedding = embedding[:self.dimensions]
        
        entity['embedding'] = embedding
        return entity


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