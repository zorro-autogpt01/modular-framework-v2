from fastapi import APIRouter, Depends, Request
from typing import List, Dict, Any
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import CodeSearchRequest

router = APIRouter(prefix="", tags=["Recommendations"], dependencies=[Depends(authorize)])


def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    out = []
    for c in candidates:
        if "_distance" not in c:
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


@router.post("/search/code")
async def search_code(request: Request, body: CodeSearchRequest):
    """
    Semantic code search with optional filters:
    - filters.languages: ["python"]
    - filters.path_prefix: "src/api"
    """
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store

    # Compute embedding
    query_embedding = None
    import inspect as _inspect
    if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
        query_embedding = await embedder.embed_text(body.query)
    else:
        query_embedding = embedder.embed_text(body.query)

    # Vector filters
    filters: Dict[str, Any] = {"repo_id": body.repository_id}
    path_prefix = None
    if body.filters:
        if isinstance(body.filters, dict):
            # direct dict pass-through support
            languages = body.filters.get("languages") or []
            if languages:
                filters["language"] = languages[0]
            path_prefix = body.filters.get("path_prefix")
        else:
            # pydantic model case not used here
            pass

    k = (body.max_results or 10) * 3
    candidates = vector_store.search(
        embedding=query_embedding,
        k=k,
        filters=filters
    )
    candidates = _normalize_candidates(candidates)

    # Post-filter for path prefix if provided
    if path_prefix:
        candidates = [c for c in candidates if str(c.get("file_path", "")).startswith(path_prefix)]

    # Prepare results
    max_results = body.max_results or 10
    final = []
    for c in candidates:
        if not c.get("file_path"):
            continue
        snippet = (c.get("code") or "")[:1000]
        similarity = 1.0 - float(c.get("_distance", 0.5))
        final.append({
            "file_path": c.get("file_path"),
            "entity_type": c.get("entity_type") or "code",
            "entity_name": c.get("name") or "",
            "similarity_score": similarity,
            "code_snippet": snippet,
            "line_number": int(c.get("start_line") or 0),
            "language": c.get("language") or "unknown"
        })
        if len(final) >= max_results:
            break

    data = {
        "query": body.query,
        "results": final,
        "total_results": len(final),
    }
    return success_response(request, data)