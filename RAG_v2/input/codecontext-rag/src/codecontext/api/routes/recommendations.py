from fastapi import APIRouter, Depends, Request, Response, HTTPException
from typing import List, Dict
import uuid
import inspect
from ...utils.responses import success_response
from ...integrations.llm_gateway import LLMGatewayClient
from ...api.dependencies import authorize
from ...api.schemas.request import RecommendationRequest, FeedbackRequest, RefineRequest
from ...core.reranker import LocalReranker
from ...core.ltr import LTRStore

router = APIRouter(prefix="", tags=["Recommendations"], dependencies=[Depends(authorize)])

def _normalize_candidates(candidates: List[Dict]) -> List[Dict]:
    out = []
    for c in candidates:
        if '_distance' in c and isinstance(c['_distance'], (int, float)):
            out.append(c); continue
        score = c.get('score', None); dist = 0.5
        if isinstance(score, (int, float)):
            if 0.0 <= score <= 1.0: dist = 1.0 - float(score)
            else: dist = float(score)
        c['_distance'] = dist; out.append(c)
    return out

@router.post("/recommendations")
async def get_recommendations(request: Request, body: RecommendationRequest, response: Response):
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    indexer = request.app.state.indexer

    if inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
        query_embedding = await embedder.embed_text(body.query)
    else:
        query_embedding = embedder.embed_text(body.query)

    filters = {'repo_id': body.repository_id}
    if body.filters and body.filters.languages:
        filters['language'] = body.filters.languages[0]

    candidates = vector_store.search(embedding=query_embedding, k=(body.max_results or 10) * 3, filters=filters)
    candidates = _normalize_candidates(candidates)

    # Local reranker
    if LocalReranker.available():
        topk = min(len(candidates), 50)
        head = LocalReranker.rerank(body.query, candidates[:topk], top_k=topk)
        candidates = head + candidates[topk:]

    # Per-repo LTR weights
    ltr = LTRStore()
    learned = ltr.load(body.repository_id) or {}
    if learned:
        # Temporarily override ranker weights
        base_w = ranker.weights.copy()
        try:
            # Merge learned weights (already normalized)
            ranker.weights = learned
            pass
        except Exception:
            ranker.weights = base_w

    centrality_scores = indexer.dependency_centrality.get(body.repository_id, {}) or {}
    comodification_scores = indexer.comodification_scores.get(body.repository_id, {}) or {}
    recency_scores = indexer.git_recency.get(body.repository_id, {}) or {}

    ranked = ranker.rank(candidates, centrality_scores, comodification_scores, recency_scores)

    files_seen = set()
    final_recommendations = []
    max_results = body.max_results or 10
    for item in ranked:
        file_path = item.get('file_path')
        if not file_path: continue
        if file_path in files_seen: continue
        files_seen.add(file_path)
        rec = {
            'file_path': file_path,
            'confidence': item.get('confidence', 0),
            'reasons': item.get('reasons', []),
            'metadata': {
                'language': item.get('language'),
                'lines_of_code': max(0, (item.get('end_line') or 0) - (item.get('start_line') or 0)),
            },
        }
        final_recommendations.append(rec)
        if len(final_recommendations) >= max_results: break

    data = {
        'session_id': session_id,
        'query': body.query,
        'recommendations': final_recommendations,
        'summary': {
            'total_files': len(final_recommendations),
            'avg_confidence': sum(r['confidence'] for r in final_recommendations) / max(1, len(final_recommendations)),
        }
    }
    return success_response(request, data, response)

@router.post("/recommendations/interactive")
async def interactive_recommendations(
    request: Request,
    body: RecommendationRequest,
    response: Response
):
    # unchanged from your dump
    session_id = str(uuid.uuid4())
    conv_id = f"rec_{session_id}"

    llm_client = LLMGatewayClient()
    try:
        await llm_client.create_conversation(
            conversation_id=conv_id,
            title=f"Code recommendations: {body.query[:50]}",
            system_prompt="You are a code recommendation assistant helping developers find relevant files.",
            metadata={
                "repository_id": body.repository_id,
                "session_id": session_id
            }
        )

        await llm_client.add_message(
            conversation_id=conv_id,
            role="user",
            content=f"Find files relevant to: {body.query}"
        )

        embedder = request.app.state.embedder
        vector_store = request.app.state.vector_store
        ranker = request.app.state.ranker
        indexer = request.app.state.indexer

        import inspect as _inspect
        if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
            query_embedding = await embedder.embed_text(body.query)
        else:
            query_embedding = embedder.embed_text(body.query)

        candidates = vector_store.search(embedding=query_embedding, k=(body.max_results or 10) * 3, filters={'repo_id': body.repository_id})
        candidates = _normalize_candidates(candidates)

        centrality_scores = indexer.dependency_centrality.get(body.repository_id, {}) or {}
        comodification_scores = indexer.comodification_scores.get(body.repository_id, {}) or {}
        recency_scores = indexer.git_recency.get(body.repository_id, {}) or {}

        ranked = ranker.rank(candidates, centrality_scores, comodification_scores, recency_scores)

        explanation_messages = [
            {"role": "system","content": "Summarize why these files are relevant."},
            {"role": "user","content": f"Query: {body.query}\n\nTop files:\n" + "\n".join(f"- {r.get('file_path')}" for r in ranked[:5] if r.get('file_path'))}
        ]

        summary_response = await llm_client.chat(messages=explanation_messages, temperature=0.3, max_tokens=200)

        data = {
            'session_id': session_id,
            'conversation_id': conv_id,
            'query': body.query,
            'recommendations': [
                {'file_path': it.get('file_path'),'confidence': it.get('confidence', 0),'reasons': it.get('reasons', [])}
                for it in ranked[: (body.max_results or 10)] if it.get('file_path')
            ],
            'explanation': summary_response.get("content"),
            'can_refine': True
        }
        return success_response(request, data, response)
    finally:
        await llm_client.close()

@router.post("/recommendations/refine")
async def refine_with_conversation(
    request: Request,
    body: RefineRequest,
    response: Response
):
    """
    Refine recommendations using conversation context
    """
    llm_client = LLMGatewayClient()

    try:
        conv_id = body.session_id

        messages = await llm_client.get_conversation_messages(conv_id, limit=50)

        original_query = None
        for msg in messages:
            if msg['role'] == 'user':
                content = msg.get('content', '')
                if 'Find files relevant to:' in content:
                    original_query = content.replace('Find files relevant to:', '').strip()
                    break

        if not original_query:
            raise HTTPException(status_code=400, detail="Could not find original query in conversation")

        await llm_client.add_message(
            conversation_id=conv_id,
            role="user",
            content=body.additional_context or "Refine the recommendations"
        )

        synthesis_messages = [
            {
                "role": "system",
                "content": "You are helping refine a code search query. Combine the original query with the refinement context to create a better search query."
            },
            {
                "role": "user",
                "content": f"Original query: {original_query}\n\nRefinement: {body.additional_context}\n\nWhat should the refined search query be?"
            }
        ]

        synthesis_response = await llm_client.chat(
            messages=synthesis_messages,
            temperature=0.3,
            max_tokens=100
        )

        refined_query = synthesis_response.get("content", original_query)

        repo_id = None
        if messages:
            first_meta = messages[0].get('meta') or messages[0].get('metadata') or {}
            repo_id = first_meta.get('repository_id')
        if not repo_id:
            raise HTTPException(status_code=400, detail="Repository ID not found in conversation")

        embedder = request.app.state.embedder
        vector_store = request.app.state.vector_store
        ranker = request.app.state.ranker
        indexer = request.app.state.indexer

        import inspect as _inspect
        if _inspect.iscoroutinefunction(getattr(embedder, "embed_text", None)):
            query_embedding = await embedder.embed_text(refined_query)
        else:
            query_embedding = embedder.embed_text(refined_query)

        filters = {'repo_id': repo_id}
        if body.filters and body.filters.languages:
            filters['language'] = body.filters.languages[0]

        max_results = body.max_results or 10
        candidates = vector_store.search(
            embedding=query_embedding,
            k=max_results * 3,
            filters=filters
        )
        candidates = _normalize_candidates(candidates)

        centrality_scores = indexer.dependency_centrality.get(repo_id, {}) or {}
        comodification_scores = indexer.comodification_scores.get(repo_id, {}) or {}
        recency_scores = indexer.git_recency.get(repo_id, {}) or {}

        ranked = ranker.rank(
            candidates,
            centrality_scores=centrality_scores,
            comodification_scores=comodification_scores,
            recency_scores=recency_scores
        )

        files_seen = set()
        final_recommendations = []
        for item in ranked:
            file_path = item.get('file_path')
            if not file_path:
                continue
            if body.negative_examples and file_path in body.negative_examples:
                continue
            if file_path in files_seen:
                continue
            files_seen.add(file_path)
            final_recommendations.append({
                'file_path': file_path,
                'confidence': item.get('confidence', 0),
                'reasons': item.get('reasons', []),
                'metadata': {
                    'language': item.get('language'),
                    'lines_of_code': max(0, (item.get('end_line') or 0) - (item.get('start_line') or 0)),
                },
                'refined': True
            })
            if len(final_recommendations) >= max_results:
                break

        explanation_messages = [
            {
                "role": "system",
                "content": "Explain how the refinement improved the recommendations."
            },
            {
                "role": "user",
                "content": f"Original query: {original_query}\n\nRefinement: {body.additional_context}\n\nNew top files:\n" +
                           "\n".join(f"- {r['file_path']}" for r in final_recommendations[:5])
            }
        ]

        explanation_response = await llm_client.chat(
            messages=explanation_messages,
            temperature=0.3,
            max_tokens=200
        )

        data = {
            'session_id': body.session_id,
            'conversation_id': conv_id,
            'original_query': original_query,
            'refined_query': refined_query,
            'refinement_context': body.additional_context,
            'recommendations': final_recommendations,
            'explanation': explanation_response.get("content"),
            'summary': {
                'total_files': len(final_recommendations),
                'avg_confidence': sum(r['confidence'] for r in final_recommendations) / max(1, len(final_recommendations)),
            }
        }

        return success_response(request, data, response)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Refinement failed: {str(e)}")

    finally:
        await llm_client.close()

@router.post("/recommendations/{session_id}/feedback")
def submit_feedback(request: Request, session_id: str, body: FeedbackRequest):
    """
    Persist feedback and adjust per-repo weights.
    """
    repo_id = request.query_params.get("repo_id") or ""  # allow as query param
    indexer = request.app.state.indexer
    ltr = LTRStore()
    centrality = indexer.dependency_centrality.get(repo_id, {}) or {}
    recency = indexer.git_recency.get(repo_id, {}) or {}
    try:
        ltr.update_with_feedback(repo_id, body.relevant_files or [], body.irrelevant_files or [], centrality, recency)
    except Exception as e:
        print(f"LTR feedback failed: {e}")
    return success_response(request, {"recorded": True, "message": "Thanks! Preferences updated."})



def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Calculate cosine similarity between two vectors"""
    import math
    dot_product = sum(a * b for a, b in zip(vec1, vec2))
    magnitude1 = math.sqrt(sum(a * a for a in vec1))
    magnitude2 = math.sqrt(sum(b * b for b in vec2))
    if magnitude1 == 0 or magnitude2 == 0:
        return 0.0
    return dot_product / (magnitude1 * magnitude2)


@router.post("/recommendations/{session_id}/feedback")
def submit_feedback(request: Request, session_id: str, body: FeedbackRequest):
    data = {"recorded": True, "message": "Thank you for your feedback! This helps improve recommendations."}
    return success_response(request, data)


