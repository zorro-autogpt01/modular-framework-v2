from fastapi import APIRouter, Depends, Request, Response
from typing import List, Dict, Optional
import uuid
from ...utils.responses import success_response
from ...integrations.llm_gateway import LLMGatewayClient
from ...api.dependencies import authorize
from ...api.schemas.request import RecommendationRequest, FeedbackRequest, RefineRequest

router = APIRouter(prefix="", tags=["Recommendations"], dependencies=[Depends(authorize)])


@router.post("/recommendations")
def get_recommendations(request: Request, body: RecommendationRequest, response: Response):
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id
    
    # Get components from app state
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    ranker = request.app.state.ranker
    
    # Step 1: Generate embedding for query
    query_embedding = embedder.embed_text(body.query)
    
    # Step 2: Search vector store
    filters = {'repo_id': body.repository_id}
    if body.filters and body.filters.languages:
        filters['language'] = body.filters.languages[0]  # Simplified
    
    candidates = vector_store.search(
        embedding=query_embedding,
        k=body.max_results * 3,  # Get more candidates for ranking
        filters=filters
    )
    
    # Step 3: Get additional signals (from app state caches)
    # These would be computed during indexing and cached
    centrality_scores = {}  # Get from dependency graph
    comodification_scores = {}  # Get from git analyzer
    recency_scores = {}  # Get from git analyzer
    
    # Step 4: Rank candidates
    ranked = ranker.rank(
        candidates,
        centrality_scores=centrality_scores,
        comodification_scores=comodification_scores,
        recency_scores=recency_scores
    )
    
    # Step 5: Group by file and take top N
    files_seen = set()
    final_recommendations = []
    
    for item in ranked:
        file_path = item['file_path']
        if file_path not in files_seen:
            files_seen.add(file_path)
            
            # Build recommendation object
            rec = {
                'file_path': file_path,
                'confidence': item['confidence'],
                'reasons': item['reasons'],
                'metadata': {
                    'language': item.get('language'),
                    'lines_of_code': item.get('end_line', 0) - item.get('start_line', 0),
                },
            }
            
            final_recommendations.append(rec)
            
            if len(final_recommendations) >= body.max_results:
                break
    
    # Build response
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


# src/codecontext/api/routes/recommendations.py

from ...integrations.llm_gateway import LLMGatewayClient

@router.post("/recommendations/interactive")
async def interactive_recommendations(
    request: Request,
    body: RecommendationRequest,
    response: Response
):
    """
    Interactive recommendations with conversation context
    
    Uses LLM Gateway conversations to maintain context across refinements
    """
    
    # Generate initial recommendations
    session_id = str(uuid.uuid4())
    conv_id = f"rec_{session_id}"
    
    # Create conversation in LLM Gateway
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
        
        # Add user query as message
        await llm_client.add_message(
            conversation_id=conv_id,
            role="user",
            content=f"Find files relevant to: {body.query}"
        )
        
        # Get recommendations (same as before)
        embedder = request.app.state.embedder
        vector_store = request.app.state.vector_store
        ranker = request.app.state.ranker
        
        query_embedding = embedder.embed_text(body.query)
        candidates = vector_store.search(
            embedding=query_embedding,
            k=body.max_results * 3,
            filters={'repo_id': body.repository_id}
        )
        
        ranked = ranker.rank(candidates)
        
        # Generate explanation using LLM
        explanation_messages = [
            {
                "role": "system",
                "content": "Summarize why these files are relevant."
            },
            {
                "role": "user",
                "content": f"Query: {body.query}\n\nTop files:\n" + 
                          "\n".join(f"- {r['file_path']}" for r in ranked[:5])
            }
        ]
        
        summary_response = await llm_client.chat(
            messages=explanation_messages,
            temperature=0.3,
            max_tokens=200
        )
        
        # Store assistant response
        await llm_client.add_message(
            conversation_id=conv_id,
            role="assistant",
            content=summary_response.get("content", "Recommendations generated."),
            metadata={"recommendation_count": len(ranked)}
        )
        
        data = {
            'session_id': session_id,
            'conversation_id': conv_id,
            'query': body.query,
            'recommendations': ranked[:body.max_results],
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
    Refine recommendations using conversation context from LLM Gateway
    
    This endpoint:
    1. Retrieves conversation history from LLM Gateway
    2. Uses context to better understand user intent
    3. Adjusts search query or filters based on refinement
    4. Re-ranks results with updated understanding
    """
    
    llm_client = LLMGatewayClient()
    
    try:
        # Get conversation history
        conv_id = body.session_id  # Session ID from previous recommendation
        
        # Retrieve conversation messages
        messages = await llm_client.get_conversation_messages(conv_id, limit=50)
        
        # Extract original query from conversation
        original_query = None
        for msg in messages:
            if msg['role'] == 'user':
                # First user message is likely the original query
                content = msg.get('content', '')
                if 'Find files relevant to:' in content:
                    original_query = content.replace('Find files relevant to:', '').strip()
                    break
        
        if not original_query:
            raise HTTPException(status_code=400, detail="Could not find original query in conversation")
        
        # Add refinement request to conversation
        await llm_client.add_message(
            conversation_id=conv_id,
            role="user",
            content=body.additional_context or "Refine the recommendations"
        )
        
        # Build enhanced query by combining original + refinement context
        # Use LLM to synthesize a better query
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
        
        # Get original repository ID from conversation metadata
        conv_details = messages[0].get('meta', {}) if messages else {}
        repo_id = conv_details.get('repository_id')
        
        if not repo_id:
            raise HTTPException(status_code=400, detail="Repository ID not found in conversation")
        
        # Apply positive/negative examples as filters
        embedder = request.app.state.embedder
        vector_store = request.app.state.vector_store
        ranker = request.app.state.ranker
        
        # Generate embedding for refined query
        if hasattr(embedder, 'embed_text'):
            # Synchronous embedder
            query_embedding = embedder.embed_text(refined_query)
        else:
            # Async embedder (LLM Gateway)
            query_embedding = await embedder.embed_text(refined_query)
        
        # Build filters from refinement request
        filters = {'repo_id': repo_id}
        
        # Apply user-provided filters
        if body.filters:
            if body.filters.languages:
                filters['language'] = body.filters.languages[0]
        
        # Search with refined query
        max_results = body.max_results or 10
        candidates = vector_store.search(
            embedding=query_embedding,
            k=max_results * 3,
            filters=filters
        )
        
        # If positive examples provided, boost similar files
        if body.positive_examples:
            # Generate embeddings for positive examples
            positive_embeddings = []
            for example_path in body.positive_examples:
                # Get file from vector store
                file_entities = vector_store.get_by_file(repo_id, example_path)
                if file_entities:
                    positive_embeddings.extend([e['embedding'] for e in file_entities])
            
            # Boost candidates similar to positive examples
            if positive_embeddings:
                for candidate in candidates:
                    # Calculate average similarity to positive examples
                    similarities = []
                    for pos_emb in positive_embeddings:
                        sim = cosine_similarity(candidate['embedding'], pos_emb)
                        similarities.append(sim)
                    
                    if similarities:
                        avg_similarity = sum(similarities) / len(similarities)
                        # Boost score
                        candidate['_distance'] = candidate.get('_distance', 0.5) * (1 - avg_similarity * 0.5)
        
        # If negative examples provided, penalize similar files
        if body.negative_examples:
            negative_embeddings = []
            for example_path in body.negative_examples:
                file_entities = vector_store.get_by_file(repo_id, example_path)
                if file_entities:
                    negative_embeddings.extend([e['embedding'] for e in file_entities])
            
            # Penalize candidates similar to negative examples
            if negative_embeddings:
                for candidate in candidates:
                    similarities = []
                    for neg_emb in negative_embeddings:
                        sim = cosine_similarity(candidate['embedding'], neg_emb)
                        similarities.append(sim)
                    
                    if similarities:
                        avg_similarity = sum(similarities) / len(similarities)
                        # Penalize by increasing distance
                        candidate['_distance'] = candidate.get('_distance', 0.5) * (1 + avg_similarity * 0.5)
        
        # Re-rank with updated scores
        ranked = ranker.rank(candidates)
        
        # Group by file and take top N
        files_seen = set()
        final_recommendations = []
        
        for item in ranked:
            file_path = item['file_path']
            
            # Skip negative examples
            if body.negative_examples and file_path in body.negative_examples:
                continue
            
            if file_path not in files_seen:
                files_seen.add(file_path)
                
                rec = {
                    'file_path': file_path,
                    'confidence': item['confidence'],
                    'reasons': item['reasons'],
                    'metadata': {
                        'language': item.get('language'),
                        'lines_of_code': item.get('end_line', 0) - item.get('start_line', 0),
                    },
                    'refined': True  # Flag indicating this is a refined result
                }
                
                final_recommendations.append(rec)
                
                if len(final_recommendations) >= max_results:
                    break
        
        # Generate explanation using LLM
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
        
        # Add assistant response to conversation
        await llm_client.add_message(
            conversation_id=conv_id,
            role="assistant",
            content=explanation_response.get("content", "Recommendations refined."),
            metadata={
                "refined": True,
                "recommendation_count": len(final_recommendations)
            }
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
    # In a real system, persist feedback and update models/weights
    data = {"recorded": True, "message": "Thank you for your feedback! This helps improve recommendations."}
    return success_response(request, data)

