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
from fastapi.staticfiles import StaticFiles  # NEW
from fnmatch import fnmatch  # NEW
import uvicorn
import PyPDF2
import tiktoken
import redis
import numpy as np
from loguru import logger
from fastapi import FastAPI, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional, Union  # ensure Optional imported

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

ADMIN_API_PREFIX = "/admin-api"


# OpenAI (v1 async client)
from openai import AsyncOpenAI

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
oai = AsyncOpenAI(api_key=OPENAI_API_KEY)

# Models (overridable via env)
RAG_EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "text-embedding-3-small")  # 1536 dims
RAG_SUMMARY_MODEL = os.getenv("RAG_SUMMARY_MODEL", "gpt-4o-mini")
RAG_ANSWER_MODEL = os.getenv("RAG_ANSWER_MODEL", "gpt-4o-mini")
# --- Chunking & embed safety limits ---
EMBED_TOKEN_LIMIT = int(os.getenv("EMBED_TOKEN_LIMIT", "8192"))  # per-input hard limit of the embed model
CHUNK_TOKENS_TARGET = int(os.getenv("CHUNK_TOKENS_TARGET", "700"))   # aim for ~700 tokens
CHUNK_TOKENS_HARD = int(os.getenv("CHUNK_TOKENS_HARD", "1000"))      # never exceed this per chunk
EMBED_MICROBATCH = int(os.getenv("EMBED_MICROBATCH", "64"))          # micro-batch size for embeddings
MAX_FILE_TOKENS = int(os.getenv("MAX_FILE_TOKENS", "50000"))         # skip absurdly large files
MINIFIED_LINE_LEN_THRESHOLD = int(os.getenv("MINIFIED_LINE_LEN_THRESHOLD", "300"))  # heuristic


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
    """Handle embeddings using OpenAI API (v1 async) with token truncation & micro-batching."""
    def __init__(self):
        self._enc = tiktoken.get_encoding("cl100k_base")

    def _truncate(self, text: str) -> str:
        toks = self._enc.encode(text or "")
        if len(toks) > EMBED_TOKEN_LIMIT:
            toks = toks[:EMBED_TOKEN_LIMIT]
        return self._enc.decode(toks)

    async def embed_text(self, text: str) -> List[float]:
        try:
            clean = self._truncate(text)
            resp = await oai.embeddings.create(model=RAG_EMBED_MODEL, input=clean)
            return resp.data[0].embedding
        except Exception as e:
            logger.error(f"Embedding failed (single): {e}")
            return [0.0] * EMBED_DIM

    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Micro-batch + per-item fallback so one oversize/invalid input doesn't kill all."""
        outputs: List[List[float]] = []
        # pre-truncate
        cleaned = [self._truncate(t) for t in texts]

        for i in range(0, len(cleaned), EMBED_MICROBATCH):
            sub = cleaned[i : i + EMBED_MICROBATCH]
            try:
                resp = await oai.embeddings.create(model=RAG_EMBED_MODEL, input=sub)
                outputs.extend([d.embedding for d in resp.data])
            except Exception as e:
                logger.error(f"Embedding micro-batch failed: {e} — falling back per-item")
                # try one-by-one to isolate the offender(s)
                for t in sub:
                    try:
                        r = await oai.embeddings.create(model=RAG_EMBED_MODEL, input=t)
                        outputs.append(r.data[0].embedding)
                    except Exception as e2:
                        logger.error(f"Embedding item failed, zeroing: {e2}")
                        outputs.append([0.0] * EMBED_DIM)
        return outputs

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
        enc = self.tokenizer

        buf: List[str] = []
        buf_start_line = 0

        def buf_text() -> str:
            return "\n".join(buf)

        def flush(end_line: int):
            if not buf:
                return
            text = buf_text()
            # Hard enforce token cap by forced slicing if needed
            toks = enc.encode(text)
            if len(toks) <= CHUNK_TOKENS_HARD:
                chunks.append(CodeChunk(
                    content=text, file_path=file_path, repo_name=repo_name,
                    language=language, start_line=buf_start_line, end_line=end_line,
                    chunk_type="code_block"
                ))
            else:
                # force split into hard-sized pieces; keep approximate line mapping
                for j in range(0, len(toks), CHUNK_TOKENS_HARD):
                    part = enc.decode(toks[j : j + CHUNK_TOKENS_HARD])
                    part_lines = part.count("\n") + 1
                    chunks.append(CodeChunk(
                        content=part, file_path=file_path, repo_name=repo_name,
                        language=language, start_line=buf_start_line, end_line=min(end_line, buf_start_line + part_lines),
                        chunk_type="code_block"
                    ))
                    buf_start = buf_start_line + part_lines - 1
                # adjust next start line roughly
            # keep small overlap
            keep = buf[-5:] if len(buf) > 5 else buf[:]
            nonlocal buf_start_line, buf
            buf = keep.copy()
            buf_start_line = end_line - len(buf) + 1

        for idx, line in enumerate(lines, start=1):
            buf.append(line)
            text_now = buf_text()
            tokens_now = len(enc.encode(text_now))

            boundaryish = (
                line.lstrip().startswith(("def ", "class ", "function ", "const ", "export "))
                or (not line.strip())  # blank
            )

            # Prefer to flush at boundaries once we hit target
            if tokens_now >= CHUNK_TOKENS_TARGET and boundaryish:
                flush(idx)
                continue

            # Hard cap no matter what
            if tokens_now >= CHUNK_TOKENS_HARD:
                flush(idx)
                continue

        # final flush
        if buf:
            flush(len(lines))

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
                            # Skip absurdly large token count
                            try:
                                _tok_count = chunking_service.tokenizer.encode(content or "")
                                if len(_tok_count) > MAX_FILE_TOKENS:
                                    logger.warning(f"Skipping very large file (>{MAX_FILE_TOKENS} toks): {relative_path}")
                                    continue
                            except Exception:
                                pass

                            # Heuristic: skip minified/one-liner-ish JS/CSS (very long average line)
                            if Path(file).suffix.lower() in {".js", ".css"}:
                                lines = content.split("\n")
                                if lines:
                                    avg_len = sum(len(l) for l in lines) / max(1, len(lines))
                                    if avg_len > MINIFIED_LINE_LEN_THRESHOLD:
                                        logger.info(f"Skipping likely minified asset: {relative_path} (avg line ~{avg_len:.0f} chars)")
                                        continue

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


# NEW: Retrieval models
class RetrieveFilters(BaseModel):
    repos: Optional[List[str]] = None
    path_prefixes: Optional[List[str]] = None   # matches payload['file_path'] startswith any
    languages: Optional[List[str]] = None       # for code
    min_score: float = 0.0

class RetrieveRequest(BaseModel):
    query: str
    top_k: int = 8
    search_code: bool = True
    search_docs: bool = True
    filters: Optional[RetrieveFilters] = None
    dedupe_by: str = "file"        # "file" | "source" | "none"
    max_snippet_chars: int = 1200  # hard cap per snippet
    build_prompt: bool = False     # if true, returns "prompt" field
    section_title: str = "Retrieved context"
    token_budget: Optional[int] = None          # approx target tokens for prompt (cl100k)

# ---------- Conversations ----------
class ConversationManager:

    def __init__(self):
        self.collection_name = "conversations"

    async def save_conversation(self, conversation_id: str, messages: List[dict], metadata: dict = None) -> dict:
        """
        Save a complete conversation thread.

        NOTE: if you pass metadata={"profile": "...", "tags": ["pets","project:omega"], ...}
        those fields will be stored on each chunk payload and are later filterable.
        """
        summary = await self._summarize_conversation(messages)

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
            # Flatten metadata into payload so we can filter by profile/tags
            payload = {
                "content": chunk["chunk_text"],
                "conversation_id": conversation_id,
                "chunk_index": i,
                "timestamp": chunk["timestamp"],
                "summary": chunk["summary"],
            }
            payload.update(chunk["metadata"] or {})

            points.append(
                PointStruct(
                    id=hashlib.md5(chunk_key.encode()).hexdigest(),
                    vector=embedding,
                    payload=payload,
                )
            )

        if points:
            qdrant.upsert(collection_name=self.collection_name, points=points)

        # cache last 20
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


    async def search_all_conversations(
        self, query: str, limit: int = 5, profile: Optional[str] = None, tags: Optional[List[str]] = None
    ) -> List[dict]:
        """
        Vector search across ALL conversations.
        - If profile is provided, restrict to that profile.
        - If tags are provided, return results that match ANY of the tags.
          (We perform one query per tag and merge.)
        """
        query_embedding = await embedding_service.embed_text(query)

        results_map: Dict[str, Dict] = {}  # id -> best point
        def add_points(points):
            for p in points or []:
                pid = str(p.id)
                if pid not in results_map or (p.score or 0) > (results_map[pid]["score"] or 0):
                    results_map[pid] = {
                        "content": p.payload.get("content", ""),
                        "conversation_id": p.payload.get("conversation_id"),
                        "timestamp": p.payload.get("timestamp"),
                        "score": p.score,
                    }

        # Build the base MUST filter (profile if provided)
        base_must = []
        if profile:
            base_must.append(FieldCondition(key="profile", match=MatchValue(value=profile)))

        # If tags provided: run one filtered query per tag and merge
        if tags:
            for tag in [t for t in tags if t]:
                must = list(base_must)
                must.append(FieldCondition(key="tags", match=MatchValue(value=tag)))
                resp = qdrant.query_points(
                    collection_name=self.collection_name,
                    query=query_embedding,
                    limit=limit,
                    query_filter=Filter(must=must),
                )
                add_points(getattr(resp, "points", []))
        else:
            # Single query with (optional) profile filter
            qfilter = Filter(must=base_must) if base_must else None
            resp = qdrant.query_points(
                collection_name=self.collection_name,
                query=query_embedding,
                limit=limit,
                query_filter=qfilter,
            )
            add_points(getattr(resp, "points", []))

        # Sort merged results by score, cap to limit
        merged = sorted(results_map.values(), key=lambda r: (r["score"] or 0.0), reverse=True)[:limit]
        return merged


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
        self._enc = tiktoken.get_encoding("cl100k_base")  # NEW

    # --- NEW: retrieval-only path ---
    async def retrieve(self, req: RetrieveRequest) -> Dict:
        """
        Return top-N snippets (code &/or docs) for client-side prompt assembly.
        Does NOT call the LLM. Optionally assembles a token-budgeted prompt.
        """
        # cache key across query + filters
        cache_key = "retrieve:" + hashlib.md5(
            json.dumps(req.dict(), sort_keys=True).encode()
        ).hexdigest()
        cached = redis_client.get(cache_key)
        if cached:
            out = json.loads(cached)
            out["usage"] = {**out.get("usage", {}), "cached": True}
            return out

        # embed
        query_emb = await embedding_service.embed_text(req.query)

        # helper: query a collection with optional rough filter for repo
        def _qdrant_query(collection: str, limit: int, repos: Optional[List[str]]):
            qfilter = None
            if repos:
                # build simple OR by doing one query per repo and merge; keep code simple/portable
                all_pts = []
                for r in repos:
                    resp = qdrant.query_points(
                        collection_name=collection,
                        query=query_emb,
                        limit=limit,
                        query_filter=Filter(must=[FieldCondition(key="repo", match=MatchValue(value=r))]),
                    )
                    all_pts.extend(getattr(resp, "points", []) or [])
                return all_pts
            # no repo filter
            resp = qdrant.query_points(collection_name=collection, query=query_emb, limit=limit)
            return getattr(resp, "points", []) or []

        # fetch generously, we’ll filter/dedupe locally
        mult = max(3, 2 * (req.top_k // 5 + 1))
        code_pts = _qdrant_query("code", req.top_k * mult, (req.filters or RetrieveFilters()).repos) if req.search_code else []
        doc_pts  = _qdrant_query("documents", req.top_k * mult, (req.filters or RetrieveFilters()).repos) if req.search_docs else []

        def _post_filter(points, is_code: bool):
            pf = req.filters or RetrieveFilters()
            out = []
            for p in points:
                pl = p.payload or {}
                if p.score is None:
                    continue
                # Qdrant (cosine): LOWER distance is better.
                # Interpret min_score from API as "max_distance" (keep name for backwards-compat).
                if pf.min_score and (p.score or 0) < pf.min_score:
                    continue
                if is_code and pf.languages and (pl.get("language") not in pf.languages):
                    continue
                if pf.path_prefixes and is_code:
                    fp = (pl.get("file_path") or "")
                    if not any(fp.startswith(prefix) for prefix in pf.path_prefixes):
                        continue
                out.append(p)
            return out

        code_pts = _post_filter(code_pts, is_code=True)
        doc_pts  = _post_filter(doc_pts,  is_code=False)

        # merge and sort by score
        all_pts = code_pts + doc_pts
        all_pts.sort(key=lambda x: (x.score or -1), reverse=True)


        # dedupe
        seen = set()
        snippets = []
        for p in all_pts:
            pl = p.payload or {}
            is_code = (pl.get("type") == "code")
            key = None
            if req.dedupe_by == "file" and is_code:
                key = f"code:{pl.get('repo')}:{pl.get('file_path')}"
            elif req.dedupe_by == "source" and not is_code:
                key = f"doc:{pl.get('source')}"
            if key and key in seen:
                continue
            if key:
                seen.add(key)

            text = (pl.get("content") or "")[: max(0, req.max_snippet_chars)]
            if not text.strip():
                continue

            if is_code:
                snippets.append({
                    "type": "code",
                    "repo": pl.get("repo"),
                    "file_path": pl.get("file_path"),
                    "language": pl.get("language"),
                    "lines": pl.get("lines"),
                    "score": p.score,
                    "id": str(p.id),
                    "text": text,
                })
            else:
                snippets.append({
                    "type": "document",
                    "repo": pl.get("repo"),
                    "source": pl.get("source"),
                    "score": p.score,
                    "id": str(p.id),
                    "text": text,
                })

            if len(snippets) >= req.top_k:
                break

        # optional prompt assembly under token budget
        prompt = None
        truncated = False
        approx_tokens = 0
        if req.build_prompt:
            parts = [f"### {req.section_title}\n"]
            approx_tokens += self._tok(parts[0])
            for i, s in enumerate(snippets, start=1):
                if s["type"] == "code":
                    head = f"[{i}] {s.get('repo','')}/{s.get('file_path','')}"
                    if s.get("lines"):
                        head += f":{s['lines']}"
                    chunk = f"{head}\n```{s.get('language','')}\n{s['text']}\n```\n\n"
                else:
                    head = f"[{i}] {s.get('source') or s.get('repo') or 'document'}"
                    chunk = f"{head}\n{s['text']}\n\n"

                need = self._tok(chunk)
                if req.token_budget and (approx_tokens + need) > req.token_budget:
                    truncated = True
                    break
                parts.append(chunk)
                approx_tokens += need

            prompt = "".join(parts)

        out = {
            "query": req.query,
            "snippets": snippets,
            "prompt": prompt,
            "usage": {
                "retrieved": len(snippets),
                "from_code": sum(1 for s in snippets if s["type"] == "code"),
                "from_docs": sum(1 for s in snippets if s["type"] == "document"),
                "approx_tokens": approx_tokens if req.build_prompt else None,
                "truncated": truncated if req.build_prompt else None,
                "cached": False,
            },
        }
        # cache
        redis_client.setex(cache_key, self.cache_ttl, json.dumps(out))
        return out

        async def query(self, question: str, search_code: bool = True, search_docs: bool = True) -> Dict:
            """
            Old /query behavior, implemented on top of the new retrieval path.
            - Runs retrieve() to collect best snippets.
            - Builds a context block.
            - Calls the LLM to produce an answer.
            """
            cache_key = "rag:" + hashlib.md5(
                f"{question}|{search_code}|{search_docs}".encode()
            ).hexdigest()
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)

            # Pull context via retrieval; keep a generous cap, no dedupe (we want strongest chunks)
            ret = await self.retrieve(RetrieveRequest(
                query=question,
                top_k=7,
                search_code=search_code,
                search_docs=search_docs,
                dedupe_by="none",
                build_prompt=True,
                section_title="Context from internal code & docs",
                token_budget=1800,  # cl100k budget for context
            ))

            context = ret.get("prompt") or "No relevant context found."
            sources = []
            for s in ret.get("snippets", []):
                if s["type"] == "code":
                    sources.append({
                        "type": "code",
                        "file": s.get("file_path"),
                        "repo": s.get("repo"),
                        "score": s.get("score"),
                    })
                else:
                    sources.append({
                        "type": "document",
                        "source": s.get("source"),
                        "repo": s.get("repo"),
                        "score": s.get("score"),
                    })

            prompt = f"""Based on the following context from our internal documents and code, answer the question.

    {context}
    Question: {question}

    Instructions:
    - Answer based primarily on the provided context.
    - If the context doesn't contain enough information, say so explicitly.
    - Be specific and reference filenames or sources when useful.
    - For code questions, prefer examples that appear in the context.
    """

            try:
                resp = await oai.chat.completions.create(
                    model=RAG_ANSWER_MODEL,
                    messages=[
                        {"role": "system", "content": "You are a helpful assistant for a small development team. Answer questions based on their internal documentation and codebase."},
                        {"role": "user", "content": prompt},
                    ],
                    max_tokens=1000,
                    temperature=0.3,
                )
                answer = resp.choices[0].message.content
            except Exception as e:
                logger.error(f"Answer generation failed: {e}")
                answer = "I couldn't generate an answer right now. Here is the context I found:\n\n" + (context or "")

            result = {
                "answer": answer,
                "sources": sources,
                "context_used": len(ret.get("snippets", [])),
            }
            redis_client.setex(cache_key, self.cache_ttl, json.dumps(result))
            return result


    # helper: approximate tokens for cl100k (NEW)
    def _tok(self, text: str) -> int:
        try:
            return len(self._enc.encode(text or ""))
        except Exception:
            # safest fallback
            return max(1, (len(text or "") // 4))


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

@app.post("/conversation/search")
async def search_conversations(request: dict):
    """
    Body:
    {
      "query": "...",
      "limit": 5,
      "profile": "Frontend Engineer",
      "tags": ["pets","project:omega"]
    }
    """
    results = await conversation_manager.search_all_conversations(
        request["query"],
        request.get("limit", 5),
        request.get("profile"),
        request.get("tags"),
    )
    return {"results": results}

# ---------- API Models ----------
class IngestRepoRequest(BaseModel):
    repo_url: str
    branch: str = "main"


class QueryRequest(BaseModel):
    question: str
    search_code: bool = True
    search_docs: bool = True


# MOUNT STATIC ADMIN UI
app.mount("/admin", StaticFiles(directory="public", html=True), name="admin")  # NEW


# ---------- helpers (NEW) ----------
def qdrant_scroll_all(collection: str, with_payload: bool = True):
    """Yield all points (no vectors) for a collection."""
    next_page = None
    while True:
        points, next_page = qdrant.scroll(
            collection_name=collection,
            limit=512,
            with_payload=with_payload,
            with_vectors=False,
            offset=next_page,
        )
        for p in points or []:
            yield p
        if not next_page:
            break


def count_by_payload_field(collection: str, field: str):
    """Return dict counter {value: count} for a given payload field."""
    from collections import Counter

    c = Counter()
    for pt in qdrant_scroll_all(collection):
        val = (pt.payload or {}).get(field)
        # allow list or scalar
        if isinstance(val, list):
            for v in val:
                if v:
                    c[str(v)] += 1
        elif val:
            c[str(val)] += 1
    return dict(c)


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

@app.get(f"{ADMIN_API_PREFIX}/info")
async def admin_info():
    """Basic config & runtime for the UI."""
    return {
        "models": {
            "embed": RAG_EMBED_MODEL,
            "summary": RAG_SUMMARY_MODEL,
            "answer": RAG_ANSWER_MODEL,
            "embed_dim": EMBED_DIM,
        },
        "chunking": {
            "chunk_size": chunking_service.chunk_size,
            "overlap": chunking_service.overlap,
        },
        "collections": list(COLLECTIONS.keys()),
        "qdrant_url": QDRANT_URL,
        "redis_host": REDIS_HOST,
    }


@app.get(f"{ADMIN_API_PREFIX}/repos")
async def admin_repos():
    """Aggregate repo counts from 'code' + 'documents' payloads."""
    from collections import defaultdict

    counts = defaultdict(lambda: {"count": 0, "collections": set()})
    # code
    for p in qdrant_scroll_all("code"):
        repo = (p.payload or {}).get("repo")
        if repo:
            counts[repo]["count"] += 1
            counts[repo]["collections"].add("code")
    # documents
    for p in qdrant_scroll_all("documents"):
        repo = (p.payload or {}).get("repo")
        if repo:
            counts[repo]["count"] += 1
            counts[repo]["collections"].add("documents")

    items = [
        {"repo": k, "count": v["count"], "collections": sorted(list(v["collections"]))}
        for k, v in counts.items()
    ]
    items.sort(key=lambda x: x["count"], reverse=True)
    return {"items": items}


@app.get(f"{ADMIN_API_PREFIX}/docs")
async def admin_docs():
    """Aggregate document sources & counts from 'documents' collection."""
    counts = count_by_payload_field("documents", "source")
    items = [{"source": k, "count": v} for k, v in counts.items()]
    items.sort(key=lambda x: x["count"], reverse=True)
    return {"items": items}


@app.get(f"{ADMIN_API_PREFIX}/tags")
async def admin_tags():
    """Aggregate tags from conversation payloads."""
    # tags could be a list or string in payloads (metadata you store)
    from collections import defaultdict

    tag_counts = defaultdict(int)
    conv_counts = defaultdict(set)  # tag -> set(conversation_id)

    for p in qdrant_scroll_all("conversations"):
        payload = p.payload or {}
        cid = payload.get("conversation_id")
        tags = payload.get("tags")
        # normalize
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        if isinstance(tags, list):
            for t in tags:
                tag_counts[t] += 1
                if cid:
                    conv_counts[t].add(cid)

    items = [
        {"tag": t, "count": tag_counts[t], "conversations": len(conv_counts[t])}
        for t in tag_counts.keys()
    ]
    items.sort(key=lambda x: x["count"], reverse=True)
    return {"items": items}


@app.get(f"{ADMIN_API_PREFIX}/conversations")
async def admin_conversations(profile: Optional[str] = None, tags: Optional[str] = None, limit: int = 100):
    """List conversations with last timestamp, tags (union), chunk count."""
    from collections import defaultdict

    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]

    index = defaultdict(lambda: {"chunks": 0, "tags": set(), "last_timestamp": None})
    for p in qdrant_scroll_all("conversations"):
        pl = p.payload or {}
        cid = pl.get("conversation_id")
        if not cid:
            continue
        if profile and pl.get("profile") != profile:
            continue
        # normalize tags for filter + union
        its_tags = pl.get("tags")
        if isinstance(its_tags, str):
            its_tags = [t.strip() for t in its_tags.split(",") if t.strip()]
        if its_tags is None:
            its_tags = []
        if tag_list and not set(tag_list).issubset(set(its_tags)):
            continue

        index[cid]["chunks"] += 1
        index[cid]["tags"].update(its_tags)
        ts = pl.get("timestamp")
        if ts:
            # keep max timestamp string (ISO sorts ok) or convert to comparable
            index[cid]["last_timestamp"] = max(index[cid]["last_timestamp"] or ts, ts)

    items = [
        {
            "conversation_id": cid,
            "chunks": data["chunks"],
            "tags": sorted(list(data["tags"])),
            "last_timestamp": data["last_timestamp"],
        }
        for cid, data in index.items()
    ]
    items.sort(key=lambda x: x["last_timestamp"] or "", reverse=True)
    return {"items": items[: max(1, limit)]}


@app.post(f"{ADMIN_API_PREFIX}/cache/clear")
async def admin_cache_clear():
    """Clear common Redis keys used by this service (best-effort)."""
    # narrow clear: only keys we know (rag:* and conversation:*). Avoid full FLUSHALL.
    cleared = 0
    for pattern in ["rag:*", "conversation:*"]:
        for key in redis_client.scan_iter(match=pattern, count=500):
            redis_client.delete(key)
            cleared += 1
    return {"cleared": cleared}

@app.post("/retrieve")
async def retrieve(req: RetrieveRequest):
    """
    Retrieval-only endpoint for chat augmentation.

    - Returns snippets (code/docs) + optional assembled prompt.
    - Does NOT call the LLM.
    """
    return await query_engine.retrieve(req)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
