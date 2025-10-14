from fastapi import APIRouter, Depends, HTTPException, Request, Response
from typing import List, Dict, Any, Optional
import uuid
import inspect as _inspect

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import PromptRequest, PromptOptions, RecommendationFilters
from ...api.schemas.response import PromptResponse, PromptMessage, SelectedChunk
from ...integrations.llm_gateway import LLMGatewayClient

router = APIRouter(prefix="/repositories", tags=["Prompts"], dependencies=[Depends(authorize)])


def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    out = []
    for c in candidates:
        if "_distance" in c and isinstance(c["_distance"], (int, float)):
            out.append(c)
            continue
        score = c.get("score", None)
        dist = 0.5
        if isinstance(score, (int, float)):
            if 0.0 <= score <= 1.0:
                dist = 1.0 - float(score)
            else:
                dist = float(score)
        c["_distance"] = dist
        out.append(c)
    return out


def _keyword_score(query: str, text: str) -> float:
    """
    Simple lexical overlap score (0..1).
    """
    if not query or not text:
        return 0.0
    q_terms = [t.lower() for t in query.split() if len(t) > 2]
    if not q_terms:
        return 0.0
    text_l = text.lower()
    hits = 0
    for t in q_terms:
        if t in text_l:
            hits += 1
    return min(1.0, hits / max(1, len(q_terms)))


def _hybrid_rerank(candidates: List[Dict], query: str, alpha: float = 0.2) -> List[Dict]:
    """
    Blend semantic similarity (1 - distance) with keyword overlap.
    new_score = (1 - distance) * (1 - alpha) + keyword_score * alpha
    """
    reranked = []
    for c in candidates:
        sem = 1.0 - float(c.get("_distance", 0.5))
        blob = " ".join([
            c.get("name") or "",
            c.get("file_path") or "",
            c.get("code") or "",
        ])[:4000]
        kw = _keyword_score(query, blob)
        blended = (sem * (1.0 - alpha)) + (kw * alpha)
        # push into confidence-like number for sorting
        c["_hybrid"] = blended
        reranked.append(c)
    reranked.sort(key=lambda x: x.get("_hybrid", 0.0), reverse=True)
    return reranked


async def _vector_top_chunks(
    request: Request,
    repo_id: str,
    query: str,
    max_chunks: int,
    languages: Optional[List[str]]
) -> List[Dict[str, Any]]:
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    indexer = request.app.state.indexer

    if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
        query_embedding = await embedder.embed_text(query)
    else:
        query_embedding = embedder.embed_text(query)

    filters = {"repo_id": repo_id, "entity_type": "chunk"}
    if languages and len(languages) > 0:
        filters["language"] = languages[0]

    candidates = vector_store.search(
        embedding=query_embedding,
        k=max_chunks * 4,
        filters=filters
    )
    candidates = _normalize_candidates(candidates)

    # Re-rank with hybrid scoring
    candidates = _hybrid_rerank(candidates, query, alpha=0.2)

    # Rank with multi-signal ranker (adds confidence and reasons)
    centrality_scores = indexer.dependency_centrality.get(repo_id, {}) or {}
    comodification_scores = indexer.comodification_scores.get(repo_id, {}) or {}
    recency_scores = indexer.git_recency.get(repo_id, {}) or {}

    ranked = ranker.rank(
        candidates,
        centrality_scores=centrality_scores,
        comodification_scores=comodification_scores,
        recency_scores=recency_scores
    )

    # De-dup by chunk id
    seen = set()
    top = []
    for it in ranked:
        cid = it.get("chunk_id") or it.get("id")
        if not cid or cid in seen:
            continue
        seen.add(cid)
        it["snippet"] = (it.get("code") or "")[:1600]
        top.append(it)
        if len(top) >= max_chunks:
            break
    return top


async def _dependency_neighbor_chunks(
    request: Request,
    repo_id: str,
    query_embedding: List[float],
    base_files: List[str],
    depth: int,
    direction: str,
    neighbor_files_limit: int,
    per_file_neighbor_chunks: int,
    languages: Optional[List[str]]
) -> List[Dict[str, Any]]:
    """
    For each base file, expand to dependency neighbors, and select top chunk(s) per neighbor file.
    """
    indexer = request.app.state.indexer
    vector_store = request.app.state.vector_store

    dep_graph = indexer.graphs.get(repo_id)
    if not dep_graph:
        return []

    neighbor_files: List[str] = []
    for f in base_files:
        try:
            deps = dep_graph.dependencies_of(f, depth=depth, direction=direction)
        except Exception:
            deps = {"imports": [], "imported_by": []}
        files = []
        if direction in ("imports", "both"):
            files.extend(deps.get("imports") or [])
        if direction in ("imported_by", "both"):
            files.extend(deps.get("imported_by") or [])
        # ensure unique
        for nf in files:
            if nf not in neighbor_files and nf not in base_files:
                neighbor_files.append(nf)
        if len(neighbor_files) >= neighbor_files_limit:
            break

    results: List[Dict[str, Any]] = []
    for nf in neighbor_files[:neighbor_files_limit]:
        filters = {"repo_id": repo_id, "entity_type": "chunk", "file_path": nf}
        if languages and len(languages) > 0:
            filters["language"] = languages[0]
        try:
            local = vector_store.search(
                embedding=query_embedding,
                k=per_file_neighbor_chunks,
                filters=filters
            )
        except Exception:
            local = []
        local = _normalize_candidates(local)
        for it in local[:per_file_neighbor_chunks]:
            it["snippet"] = (it.get("code") or "")[:1200]
            results.append(it)
    return results


@router.post("/{repo_id}/prompt")
async def build_prompt(
    request: Request,
    repo_id: str,
    body: PromptRequest,
    response: Response
):
    """
    Build a ready-to-send LLM prompt under a token budget:
    - Retrieve top chunks
    - Optionally expand via dependency neighbors
    - Assemble messages with minimal context and constraints
    """
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    options = body.options or PromptOptions()
    model = options.model or None
    temperature = options.temperature or 0.2
    max_tokens = options.max_tokens or 2200
    max_chunks = options.max_chunks or 12
    per_file_neighbor_chunks = options.per_file_neighbor_chunks or 2
    include_dep = options.include_dependency_expansion if options.include_dependency_expansion is not None else True
    dep_depth = options.dependency_depth or 1
    dep_dir = options.dependency_direction or "both"
    neighbor_files_limit = options.neighbor_files_limit or 4
    languages = options.languages or (body.filters.languages if body.filters and body.filters.languages else None)

    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    indexer = request.app.state.indexer

    # 1) Base top chunks
    base_chunks = await _vector_top_chunks(
        request=request,
        repo_id=repo_id,
        query=body.query,
        max_chunks=max_chunks,
        languages=languages
    )

    # 2) Dependency neighbor expansion
    neighbor_chunks: List[Dict[str, Any]] = []
    if include_dep and base_chunks:
        # get embedding once for neighbor searches
        import inspect as _inspect2
        if _inspect2.iscoroutinefunction(getattr(embedder, "embed_text", None)):
            q_emb = await embedder.embed_text(body.query)
        else:
            q_emb = embedder.embed_text(body.query)

        base_files = list({b.get("file_path") for b in base_chunks if b.get("file_path")})
        neighbor_chunks = await _dependency_neighbor_chunks(
            request=request,
            repo_id=repo_id,
            query_embedding=q_emb,
            base_files=base_files,
            depth=dep_depth,
            direction=dep_dir,
            neighbor_files_limit=neighbor_files_limit,
            per_file_neighbor_chunks=per_file_neighbor_chunks,
            languages=languages
        )

    # 3) Assemble prompt with token budgeting
    from ...core.prompt import PromptAssembler
    assembler = PromptAssembler(LLMGatewayClient())
    messages, usage = await assembler.assemble(
        query=body.query,
        base_chunks=base_chunks,
        neighbor_chunks=neighbor_chunks,
        model=model,
        system_prompt=options.system_prompt,
        temperature=temperature,
        max_tokens=max_tokens
    )

    selected_chunks = []
    # Extract selected chunks from messages by correlating with base/neighbor chunks
    # Instead, we rely on assembler returning selected info via messages; we provided only text.
    # So we rebuild selected list from the chunks we attempted to include (best effort).
    seen_ids = set()
    for c in base_chunks + neighbor_chunks:
        cid = c.get("chunk_id") or c.get("id")
        if not cid or cid in seen_ids:
            continue
        # If snippet text appears in messages, it's likely included
        snip = (c.get("snippet") or c.get("code") or "")[:60]
        included = any(snip and (snip in m.get("content", "")) for m in messages)
        if included:
            selected_chunks.append({
                "id": cid,
                "file_path": c.get("file_path"),
                "start_line": int(c.get("start_line") or 0),
                "end_line": int(c.get("end_line") or 0),
                "language": c.get("language") or "unknown",
                "confidence": int(c.get("confidence") or 0),
                "reasons": c.get("reasons") or []
            })
            seen_ids.add(cid)

    data = {
        "query": body.query,
        "model": model,
        "messages": messages,
        "selected_chunks": selected_chunks,
        "token_usage": usage,
        "summary": {
            "base_chunks_requested": max_chunks,
            "base_chunks_found": len(base_chunks),
            "neighbor_chunks_added": len([sc for sc in selected_chunks if sc["id"] not in {b.get('id') or b.get('chunk_id') for b in base_chunks}]),
            "dependency_expansion": include_dep,
            "dependency_depth": dep_depth,
            "dependency_direction": dep_dir
        }
    }
    return success_response(request, data, response)
