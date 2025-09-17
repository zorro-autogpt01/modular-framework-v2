# rag_system.py
"""
Simple Production RAG for Small Organizations
- Ingests: GitHub repos, PDFs, text files
- Uses OpenAI v1 async client (AsyncOpenAI)
- Embeddings: text-embedding-3-small (1536 dims by default)
- Vector store: Qdrant
- Cache: Redis
"""

import os
import io
import git
import json
import hashlib
import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional

import uvicorn
import PyPDF2
import tiktoken
import redis
import numpy as np
from loguru import logger
from fastapi import FastAPI, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)

# ---------- Logging ----------
logger.add("rag_system.log", rotation="500 MB", retention="30 days", level="INFO")

# ---------- FastAPI ----------
app = FastAPI(title="Simple RAG System", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten for prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Env & Clients ----------
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")

# OpenAI (v1 async client)
from openai import AsyncOpenAI

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
oai = AsyncOpenAI(api_key=OPENAI_API_KEY)

# Models (overridable via env)
RAG_EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "text-embedding-3-small")  # 1536 dims
RAG_SUMMARY_MODEL = os.getenv("RAG_SUMMARY_MODEL", "gpt-4o-mini")
RAG_ANSWER_MODEL = os.getenv("RAG_ANSWER_MODEL", "gpt-4o-mini")

# Qdrant & Redis
qdrant = QdrantClient(url=QDRANT_URL)
redis_client = redis.Redis(host=REDIS_HOST, decode_responses=True)

# Embedding sizes (ensure collection dims match model)
EMBED_DIMS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}
EMBED_DIM = EMBED_DIMS.get(RAG_EMBED_MODEL, 1536)

# Collections (all using the same dim)
COLLECTIONS = {
    "code": {"size": EMBED_DIM, "distance": Distance.COSINE},
    "documents": {"size": EMBED_DIM, "distance": Distance.COSINE},
    "conversations": {"size": EMBED_DIM, "distance": Distance.COSINE},
}

# ---------- Embeddings ----------
class EmbeddingService:
    """Handle embeddings using OpenAI API (v1 async)"""

    @staticmethod
    async def embed_text(text: str) -> List[float]:
        try:
            resp = await oai.embeddings.create(model=RAG_EMBED_MODEL, input=text)
            return resp.data[0].embedding
        except Exception as e:
            logger.error(f"Embedding failed: {e}")
            return [0.0] * EMBED_DIM

    @staticmethod
    async def embed_batch(texts: List[str]) -> List[List[float]]:
        try:
            resp = await oai.embeddings.create(model=RAG_EMBED_MODEL, input=texts)
            return [item.embedding for item in resp.data]
        except Exception as e:
            logger.error(f"Batch embedding failed: {e}")
            return [[0.0] * EMBED_DIM for _ in texts]


embedding_service = EmbeddingService()

# ---------- Chunking ----------
@dataclass
class CodeChunk:
    content: str
    file_path: str
    repo_name: str
    language: str
    start_line: int
    end_line: int
    chunk_type: str


class ChunkingService:
    """Smart chunking for different file types"""

    def __init__(self, chunk_size: int = 1000, overlap: int = 200):
        self.chunk_size = chunk_size
        self.overlap = overlap
        self.tokenizer = tiktoken.get_encoding("cl100k_base")

    def chunk_code(self, content: str, file_path: str, repo_name: str) -> List[CodeChunk]:
        chunks: List[CodeChunk] = []
        lines = content.split("\n")
        language = Path(file_path).suffix.lstrip(".")

        current_chunk: List[str] = []
        current_start = 0

        for i, line in enumerate(lines):
            current_chunk.append(line)

            is_boundary = (
                line.strip().startswith(("def ", "class ", "function ", "const ", "export "))
                or (len("\n".join(current_chunk)) > self.chunk_size and not line.strip())
            )

            if is_boundary and len("\n".join(current_chunk)) > 500:
                chunks.append(
                    CodeChunk(
                        content="\n".join(current_chunk),
                        file_path=file_path,
                        repo_name=repo_name,
                        language=language,
                        start_line=current_start,
                        end_line=i,
                        chunk_type="code_block",
                    )
                )
                current_chunk = current_chunk[-5:] if len(current_chunk) > 5 else []
                current_start = i - len(current_chunk) + 1

        if current_chunk:
            chunks.append(
                CodeChunk(
                    content="\n".join(current_chunk),
                    file_path=file_path,
                    repo_name=repo_name,
                    language=language,
                    start_line=current_start,
                    end_line=len(lines),
                    chunk_type="code_block",
                )
            )

        return chunks

    def chunk_text(self, content: str, metadata: dict) -> List[dict]:
        chunks: List[dict] = []
        tokens = self.tokenizer.encode(content or "")
        step = self.chunk_size - self.overlap
        if step <= 0:
            step = self.chunk_size

        for i in range(0, len(tokens), step):
            chunk_tokens = tokens[i : i + self.chunk_size]
            chunk_text = self.tokenizer.decode(chunk_tokens)
            chunks.append({"content": chunk_text, "metadata": metadata, "chunk_index": len(chunks)})

        return chunks


# ---------- Ingestion ----------
class GitHubIngester:
    """Handle GitHub repository ingestion"""

    def __init__(self, chunking_service: ChunkingService):
        self.chunking_service = chunking_service
        self.ignored_extensions = {
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".ico",
            ".svg",
            ".exe",
            ".dll",
            ".so",
            ".lock",
            ".pdf",
        }
        self.code_extensions = {
            ".py",
            ".js",
            ".ts",
            ".jsx",
            ".tsx",
            ".java",
            ".cpp",
            ".c",
            ".go",
            ".rs",
            ".php",
            ".rb",
            ".swift",
            ".cs",
        }

    async def ingest_repo(self, repo_url: str, branch: str = "main") -> Dict:
        repo_name = repo_url.split("/")[-1].replace(".git", "")
        repo_path = f"/tmp/{repo_name}_{datetime.now().timestamp()}"

        try:
            logger.info(f"Cloning repository: {repo_url}")
            _ = git.Repo.clone_from(repo_url, repo_path, branch=branch, depth=1)

            processed_files = 0
            total_chunks = 0

            for root, dirs, files in os.walk(repo_path):
                dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ["node_modules", "vendor", "dist", "build", ".git"]]

                for file in files:
                    file_path = os.path.join(root, file)
                    relative_path = os.path.relpath(file_path, repo_path)

                    if Path(file).suffix.lower() in self.ignored_extensions:
                        continue

                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                            content = f.read()

                        if not content or len(content) > 1_000_000:
                            continue

                        if Path(file).suffix.lower() in self.code_extensions:
                            chunks = self.chunking_service.chunk_code(content, relative_path, repo_name)
                            await self._store_code_chunks(chunks)
                        else:
                            chunks = self.chunking_service.chunk_text(
                                content,
                                {"source": relative_path, "repo": repo_name, "type": "text"},
                            )
                            await self._store_document_chunks(chunks)

                        processed_files += 1
                        total_chunks += len(chunks)

                    except Exception as e:
                        logger.warning(f"Failed to process {file_path}: {e}")
                        continue

            import shutil

            shutil.rmtree(repo_path, ignore_errors=True)

            logger.info(f"Ingested {repo_name}: {processed_files} files, {total_chunks} chunks")
            return {"repo": repo_name, "files_processed": processed_files, "chunks_created": total_chunks}

        except Exception as e:
            logger.error(f"Failed to ingest repository: {e}")
            raise

    async def _store_code_chunks(self, chunks: List[CodeChunk]):
        points: List[PointStruct] = []
        texts = [chunk.content for chunk in chunks]
        embeddings = await embedding_service.embed_batch(texts)

        for chunk, embedding in zip(chunks, embeddings):
            chunk_id = hashlib.md5(f"{chunk.repo_name}:{chunk.file_path}:{chunk.start_line}".encode()).hexdigest()
            points.append(
                PointStruct(
                    id=chunk_id,
                    vector=embedding,
                    payload={
                        "content": chunk.content,
                        "file_path": chunk.file_path,
                        "repo": chunk.repo_name,
                        "language": chunk.language,
                        "lines": f"{chunk.start_line}-{chunk.end_line}",
                        "type": "code",
                    },
                )
            )

        if points:
            qdrant.upsert(collection_name="code", points=points)

    async def _store_document_chunks(self, chunks: List[dict]):
        points: List[PointStruct] = []
        texts = [chunk["content"] for chunk in chunks]
        embeddings = await embedding_service.embed_batch(texts)

        for chunk, embedding in zip(chunks, embeddings):
            # Stable id by using sorted metadata + chunk index
            meta_str = json.dumps(chunk["metadata"], sort_keys=True)
            chunk_id = hashlib.md5(f"{meta_str}:{chunk['chunk_index']}".encode()).hexdigest()

            payload = {"content": chunk["content"], **chunk["metadata"]}
            points.append(PointStruct(id=chunk_id, vector=embedding, payload=payload))

        if points:
            qdrant.upsert(collection_name="documents", points=points)


# ---------- Conversations ----------
class ConversationManager:
    """Manage conversation storage and retrieval"""

    def __init__(self):
        self.collection_name = "conversations"

    async def save_conversation(self, conversation_id: str, messages: List[dict], metadata: dict = None) -> dict:
        """Save a complete conversation thread"""
        summary = await self._summarize_conversation(messages)

        # Chunk by every 3 messages for better retrieval
        chunks = []
        current_chunk = []

        for msg in messages:
            current_chunk.append(f"{msg['role']}: {msg['content']}")
            if len(current_chunk) >= 3:
                chunks.append(
                    {
                        "conversation_id": conversation_id,
                        "chunk_text": "\n".join(current_chunk),
                        "timestamp": datetime.now().isoformat(),
                        "summary": summary,
                        "metadata": metadata or {},
                    }
                )
                current_chunk = [current_chunk[-1]]

        if current_chunk:
            chunks.append(
                {
                    "conversation_id": conversation_id,
                    "chunk_text": "\n".join(current_chunk),
                    "timestamp": datetime.now().isoformat(),
                    "summary": summary,
                    "metadata": metadata or {},
                }
            )

        points: List[PointStruct] = []
        for i, chunk in enumerate(chunks):
            embedding = await embedding_service.embed_text(chunk["chunk_text"])
            chunk_key = f"{conversation_id}_{i}_{datetime.now().timestamp()}"
            points.append(
                PointStruct(
                    id=hashlib.md5(chunk_key.encode()).hexdigest(),
                    vector=embedding,
                    payload={
                        "content": chunk["chunk_text"],
                        "conversation_id": conversation_id,
                        "chunk_index": i,
                        "timestamp": chunk["timestamp"],
                        "summary": chunk["summary"],
                        **chunk["metadata"],
                    },
                )
            )

        if points:
            qdrant.upsert(collection_name=self.collection_name, points=points)

        # Cache last 20
        redis_client.setex(
            f"conversation:{conversation_id}",
            86400 * 7,
            json.dumps({"messages": messages[-20:], "summary": summary, "chunks_stored": len(chunks)}),
        )

        return {"conversation_id": conversation_id, "chunks_saved": len(chunks), "summary": summary}

    async def get_conversation_context(self, conversation_id: str, current_query: str = None) -> dict:
        cached = redis_client.get(f"conversation:{conversation_id}")
        recent_messages = []
        if cached:
            data = json.loads(cached)
            recent_messages = data.get("messages", [])

        relevant_history = []
        if current_query:
            query_embedding = await embedding_service.embed_text(current_query)
            resp = qdrant.query_points(
                collection_name=self.collection_name,
                query=query_embedding,
                limit=5,
                query_filter=Filter(
                    must=[FieldCondition(key="conversation_id", match=MatchValue(value=conversation_id))]
                ),
            )
            # Keep only high-scoring chunks
            for r in getattr(resp, "points", []):
                if r.score is not None and r.score > 0.7:
                    relevant_history.append(r.payload)

        return {"recent_messages": recent_messages, "relevant_history": relevant_history, "conversation_id": conversation_id}

    async def search_all_conversations(self, query: str, limit: int = 5) -> List[dict]:
        query_embedding = await embedding_service.embed_text(query)
        resp = qdrant.query_points(collection_name=self.collection_name, query=query_embedding, limit=limit)
        results = getattr(resp, "points", []) or []
        return [
            {
                "content": r.payload.get("content", ""),
                "conversation_id": r.payload.get("conversation_id"),
                "timestamp": r.payload.get("timestamp"),
                "score": r.score,
            }
            for r in results
        ]

    async def _summarize_conversation(self, messages: List[dict]) -> str:
        if len(messages) < 3:
            return "Brief conversation"
        conversation_text = "\n".join([f"{m['role']}: {m['content'][:200]}" for m in messages[-10:]])
        try:
            resp = await oai.chat.completions.create(
                model=RAG_SUMMARY_MODEL,
                messages=[
                    {"role": "system", "content": "Summarize this conversation in 2-3 sentences."},
                    {"role": "user", "content": conversation_text},
                ],
                max_tokens=100,
            )
            return resp.choices[0].message.content
        except Exception as e:
            logger.warning(f"Summary failed, falling back: {e}")
            return conversation_text[:400]


# ---------- Query Engine ----------
class QueryEngine:
    """Handle RAG queries with caching"""

    def __init__(self):
        self.cache_ttl = 3600

    async def query(self, question: str, search_code: bool = True, search_docs: bool = True) -> Dict:
        cache_key = f"rag:{hashlib.md5(question.encode()).hexdigest()}"
        cached = redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

        question_embedding = await embedding_service.embed_text(question)

        all_results = []

        if search_code:
            resp_code = qdrant.query_points(collection_name="code", query=question_embedding, limit=5)
            all_results.extend(getattr(resp_code, "points", []) or [])

        if search_docs:
            resp_docs = qdrant.query_points(collection_name="documents", query=question_embedding, limit=5)
            all_results.extend(getattr(resp_docs, "points", []) or [])

        # Sort by score descending
        all_results.sort(key=lambda x: (x.score or 0.0), reverse=True)
        top_results = all_results[:7]

        context_parts: List[str] = []
        sources: List[dict] = []

        for result in top_results:
            payload = result.payload or {}
            if payload.get("type") == "code":
                context_parts.append(
                    f"Code from {payload.get('file_path','?')}:\n```{payload.get('language','')}\n{payload.get('content','')}\n```"
                )
                sources.append(
                    {
                        "type": "code",
                        "file": payload.get("file_path"),
                        "repo": payload.get("repo"),
                        "score": result.score,
                    }
                )
            else:
                context_parts.append(f"Document excerpt:\n{payload.get('content','')}")
                sources.append({"type": "document", "source": payload.get("source"), "score": result.score})

        context = "\n\n---\n\n".join(context_parts) if context_parts else "No relevant context found."

        prompt = f"""Based on the following context from our internal documents and code, answer the question.

Context:
{context}

Question: {question}

Instructions:
- Answer based primarily on the provided context
- If the context doesn't contain enough information, say so
- Be specific and reference the sources when possible
- For code questions, provide examples from the context

Answer:"""

        try:
            resp = await oai.chat.completions.create(
                model=RAG_ANSWER_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant for a small development team. Answer questions based on their internal documentation and codebase.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=1000,
                temperature=0.3,
            )
            answer = resp.choices[0].message.content
        except Exception as e:
            logger.error(f"Answer generation failed: {e}")
            # Fallback: return just the stitched context
            answer = "I couldn't generate an answer right now. Here is the context I found:\n\n" + context

        result = {"answer": answer, "sources": sources, "context_used": len(context_parts)}
        redis_client.setex(cache_key, self.cache_ttl, json.dumps(result))
        return result


# ---------- Services ----------
chunking_service = ChunkingService()
github_ingester = GitHubIngester(chunking_service)
query_engine = QueryEngine()
conversation_manager = ConversationManager()


# ---------- Startup ----------
@app.on_event("startup")
async def startup():
    # Check embedding dimension vs collection size
    for name, cfg in COLLECTIONS.items():
        try:
            qdrant.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=cfg["size"], distance=cfg["distance"]),
            )
            logger.info(f"Created collection: {name}")
        except Exception:
            logger.info(f"Collection {name} already exists")

    if EMBED_DIM != COLLECTIONS["code"]["size"]:
        logger.warning(
            f"Embedding model '{RAG_EMBED_MODEL}' has dim {EMBED_DIM}, "
            f"collections are configured for {COLLECTIONS['code']['size']}. "
            "Ensure they match!"
        )


# ---------- API Models ----------
class IngestRepoRequest(BaseModel):
    repo_url: str
    branch: str = "main"


class QueryRequest(BaseModel):
    question: str
    search_code: bool = True
    search_docs: bool = True


# ---------- Endpoints ----------
@app.post("/ingest/repo")
async def ingest_repository(request: IngestRepoRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(github_ingester.ingest_repo, request.repo_url, request.branch)
    return {"message": "Repository ingestion started", "repo": request.repo_url}


@app.post("/ingest/pdf")
async def ingest_pdf(file: UploadFile):
    content = await file.read()
    pdf_reader = PyPDF2.PdfReader(io.BytesIO(content))

    full_text = ""
    for page in pdf_reader.pages:
        try:
            full_text += page.extract_text() or ""
        except Exception:
            continue

    chunks = chunking_service.chunk_text(
        full_text,
        {"source": file.filename, "type": "pdf", "pages": len(pdf_reader.pages)},
    )

    texts = [c["content"] for c in chunks]
    embeddings = await embedding_service.embed_batch(texts)

    points: List[PointStruct] = []
    for chunk, embedding in zip(chunks, embeddings):
        chunk_id = hashlib.md5(f"{file.filename}:{chunk['chunk_index']}".encode()).hexdigest()
        payload = {"content": chunk["content"], **chunk["metadata"]}
        points.append(PointStruct(id=chunk_id, vector=embedding, payload=payload))

    if points:
        qdrant.upsert(collection_name="documents", points=points)

    return {"message": f"Ingested {file.filename}", "chunks": len(chunks)}


@app.post("/query")
async def query(request: QueryRequest):
    return await query_engine.query(request.question, request.search_code, request.search_docs)


@app.post("/conversation/save")
async def save_conversation(request: dict):
    result = await conversation_manager.save_conversation(
        conversation_id=request["conversation_id"],
        messages=request["messages"],
        metadata=request.get("metadata", {}),
    )
    return result


@app.get("/conversation/{conversation_id}")
async def get_conversation(conversation_id: str, current_query: Optional[str] = None):
    return await conversation_manager.get_conversation_context(conversation_id, current_query)


@app.post("/conversation/search")
async def search_conversations(request: dict):
    results = await conversation_manager.search_all_conversations(request["query"], request.get("limit", 5))
    return {"results": results}


@app.get("/stats")
async def get_stats():
    stats = {}
    for collection_name in COLLECTIONS.keys():
        try:
            info = qdrant.get_collection(collection_name)
            stats[f"{collection_name}_chunks"] = getattr(info, "points_count", 0)
        except Exception:
            stats[f"{collection_name}_chunks"] = 0
    stats["total_chunks"] = sum(v for v in stats.values())
    return stats


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.delete("/clear/{collection}")
async def clear_collection(collection: str):
    if collection in COLLECTIONS:
        qdrant.delete_collection(collection)
        qdrant.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=COLLECTIONS[collection]["size"], distance=COLLECTIONS[collection]["distance"]),
        )
        return {"message": f"Cleared {collection}"}
    raise HTTPException(status_code=404, detail="Collection not found")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
