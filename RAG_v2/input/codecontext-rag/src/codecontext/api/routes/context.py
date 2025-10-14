from fastapi import APIRouter, Depends, HTTPException, Request, Response
from typing import List, Dict
import uuid
import inspect as _inspect

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import ContextRequest
from ...api.schemas.response import ContextResponse

router = APIRouter(prefix="/repositories", tags=["Context"], dependencies=[Depends(authorize)])


def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    """
    Ensure candidates carry a '_distance' field (lower is better) for the ranker.
    Heuristics for LanceDB outputs:
    - Prefer '_distance' if present.
    - If 'score' present:
        - If 0 <= score <= 1.0, assume it's similarity; convert to distance = 1 - score.
        - Else assume it's already a distance.
    - Otherwise, default to 0.5.
    """
    out = []
    for c in candidates:
        if '_distance' in c and isinstance(c['_distance'], (int, float)):
            out.append(c)
            continue
        score = c.get('score', None)
        dist = 0.5
        if isinstance(score, (int, float)):
            if 0.0 <= score <= 1.0:
                dist = 1.0 - float(score)
            else:
                dist = float(score)
        c['_distance'] = dist
        out.append(c)
    return out


@router.post("/{repo_id}/context")
async def get_minimal_context(
    request: Request,
    repo_id: str,
    body: ContextRequest,
    response: Response
):
    """
    Retrieve minimal, high-signal code chunks relevant to a feature/bug query.
    """
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    indexer = request.app.state.indexer

    # Step 1: Embedding for query
    if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
        query_embedding = await embedder.embed_text(body.query)
    else:
        query_embedding = embedder.embed_text(body.query)

    # Step 2: Vector search limited to chunk entities
    k = (body.max_chunks or 8) * 3
    filters = {'repo_id': repo_id, 'entity_type': 'chunk'}
    if body.filters and body.filters.languages:
        filters['language'] = body.filters.languages[0]

    candidates = vector_store.search(
        embedding=query_embedding,
        k=k,
        filters=filters
    )
    candidates = _normalize_candidates(candidates)

    # Step 3: Rank with additional signals
    centrality_scores = indexer.dependency_centrality.get(repo_id, {}) or {}
    comodification_scores = indexer.comodification_scores.get(repo_id, {}) or {}
    recency_scores = indexer.git_recency.get(repo_id, {}) or {}

    ranked = ranker.rank(
        candidates,
        centrality_scores=centrality_scores,
        comodification_scores=comodification_scores,
        recency_scores=recency_scores
    )

    # Step 4: Select top-N distinct chunks
    max_chunks = body.max_chunks or 8
    seen_chunk_ids = set()
    results = []

    for item in ranked:
        file_path = item.get('file_path')
        chunk_id = item.get('chunk_id') or item.get('id')
        if not file_path or not chunk_id:
            continue
        if chunk_id in seen_chunk_ids:
            continue
        seen_chunk_ids.add(chunk_id)

        snippet = (item.get('code') or '')[:1200]  # keep payload small
        results.append({
            'file_path': file_path,
            'start_line': int(item.get('start_line') or 0),
            'end_line': int(item.get('end_line') or 0),
            'language': item.get('language') or 'unknown',
            'snippet': snippet,
            'confidence': int(item.get('confidence', 0)),
            'reasons': item.get('reasons', []),
            'distance': float(item.get('_distance', 0.5))
        })
        if len(results) >= max_chunks:
            break

    # Optional: neighbor expansion (include adjacent chunks from same file)
    if body.expand_neighbors and results:
        expanded = list(results)
        for r in results:
            if len(expanded) >= max_chunks:
                break
            file_entities = vector_store.get_by_file(repo_id, r['file_path'])
            file_chunks = [e for e in file_entities if e.get('entity_type') == 'chunk']
            # Sort by proximity to selected chunk
            def proximity_score(e):
                s = int(e.get('start_line') or 0)
                # distance in lines from the center of r
                center = (r['start_line'] + r['end_line']) // 2
                es = s
                return abs(es - center)
            file_chunks.sort(key=proximity_score)
            for ch in file_chunks[:2]:
                ch_id = ch.get('chunk_id') or ch.get('id')
                if ch_id in seen_chunk_ids:
                    continue
                seen_chunk_ids.add(ch_id)
                expanded.append({
                    'file_path': ch.get('file_path'),
                    'start_line': int(ch.get('start_line') or 0),
                    'end_line': int(ch.get('end_line') or 0),
                    'language': ch.get('language') or 'unknown',
                    'snippet': (ch.get('code') or '')[:1000],
                    'confidence': int(ch.get('confidence', 0)),
                    'reasons': ch.get('reasons', []),
                    'distance': float(ch.get('_distance', 0.5))
                })
                if len(expanded) >= max_chunks:
                    break
        results = expanded[:max_chunks]

    data = {
        'query': body.query,
        'chunks': results,
        'summary': {
            'total_chunks': len(results),
            'avg_confidence': sum(r['confidence'] for r in results) / max(1, len(results)),
        }
    }

    return success_response(request, data, response)
