# src/codecontext/api/routes/features.py
from fastapi import APIRouter, Depends, HTTPException, Request, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...workflows.product_analysis import ProductAnalysisWorkflow

router = APIRouter(prefix="/features", tags=["Features"], dependencies=[Depends(authorize)])


class TriggerAnalysisRequest(BaseModel):
    """Request to trigger product analysis workflow"""
    repo_id: str
    skip_feature_extraction: bool = False


class FeatureQuery(BaseModel):
    """Query parameters for feature search"""
    category: Optional[str] = None
    min_confidence: float = 0.5


class SuggestionQuery(BaseModel):
    """Query parameters for suggestion search"""
    status: Optional[str] = None
    priority: Optional[str] = None


@router.get("/{repo_id}")
async def list_features(
    request: Request,
    repo_id: str,
    category: Optional[str] = None,
    min_confidence: float = 0.5
):
    """List extracted features for a repository"""
    
    feature_store = request.app.state.feature_store
    
    features = feature_store.get_features(
        repo_id=repo_id,
        category=category,
        min_confidence=min_confidence
    )
    
    # Remove embeddings from response (too large)
    for f in features:
        f.pop('embedding', None)
    
    data = {
        'repo_id': repo_id,
        'total_features': len(features),
        'features': features
    }
    
    return success_response(request, data)


@router.get("/{repo_id}/suggestions")
async def list_suggestions(
    request: Request,
    repo_id: str,
    status: Optional[str] = None,
    priority: Optional[str] = None
):
    """List feature suggestions for a repository"""
    
    feature_store = request.app.state.feature_store
    
    suggestions = feature_store.get_suggestions(
        repo_id=repo_id,
        status=status,
        priority=priority
    )
    
    # Remove embeddings
    for s in suggestions:
        s.pop('embedding', None)
    
    data = {
        'repo_id': repo_id,
        'total_suggestions': len(suggestions),
        'suggestions': suggestions
    }
    
    return success_response(request, data)


@router.get("/{repo_id}/suggestions/{suggestion_id}")
async def get_suggestion_detail(
    request: Request,
    repo_id: str,
    suggestion_id: str
):
    """Get detailed information about a suggestion including conversation"""
    
    feature_store = request.app.state.feature_store
    
    # Get suggestion
    suggestions = feature_store.get_suggestions(repo_id=repo_id)
    suggestion = next((s for s in suggestions if s['id'] == suggestion_id), None)
    
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    
    # Get conversation history
    conversation = feature_store.get_conversation(suggestion_id)
    
    suggestion.pop('embedding', None)
    
    data = {
        'suggestion': suggestion,
        'conversation': conversation
    }
    
    return success_response(request, data)


@router.post("/{repo_id}/suggestions/{suggestion_id}/status")
async def update_suggestion_status(
    request: Request,
    repo_id: str,
    suggestion_id: str,
    status: str
):
    """Update suggestion status (proposed/approved/in_progress/completed/rejected)"""
    
    feature_store = request.app.state.feature_store
    
    valid_statuses = ['proposed', 'approved', 'in_progress', 'completed', 'rejected']
    if status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {', '.join(valid_statuses)}")
    
    updated = feature_store.update_suggestion_status(suggestion_id, status)
    
    if not updated:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    
    return success_response(request, {'status': status, 'updated': True})


@router.get("/{repo_id}/analyses")
async def list_analyses(
    request: Request,
    repo_id: str,
    agent_role: Optional[str] = None
):
    """List agent analyses for a repository"""
    
    feature_store = request.app.state.feature_store
    
    analyses = feature_store.get_analyses(
        repo_id=repo_id,
        agent_role=agent_role
    )
    
    data = {
        'repo_id': repo_id,
        'total_analyses': len(analyses),
        'analyses': analyses
    }
    
    return success_response(request, data)


@router.post("/{repo_id}/analyze")
async def trigger_product_analysis(
    request: Request,
    repo_id: str,
    body: TriggerAnalysisRequest,
    background_tasks: BackgroundTasks
):
    """
    Trigger Stage 1 product analysis workflow
    
    This runs PM/Marketer agents to analyze the product and generate suggestions
    """
    
    repo_store = request.app.state.repo_store
    feature_store = request.app.state.feature_store
    llm_client = request.app.state.llm_client
    embedder = request.app.state.embedder
    vector_store = request.app.state.vector_store
    indexer = request.app.state.indexer
    
    # Get repository
    repo = repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")
    
    repo_path = repo.get('local_path')
    if not repo_path:
        raise HTTPException(status_code=400, detail="Repository has no local path")
    
    # Get parsed data (should exist from indexing)
    # In production, you'd load this from persistence
    # For now, we'll use a minimal structure
    parsed_data = {
        'files': [],
        'language_stats': {}
    }
    
    # Create workflow
    workflow = ProductAnalysisWorkflow(
        feature_store=feature_store,
        llm_client=llm_client,
        embedder=embedder
    )
    
    # Run in background
    async def run_workflow():
        try:
            results = await workflow.run(
                repo_id=repo_id,
                repo_path=repo_path,
                parsed_data=parsed_data,
                vector_store=vector_store,
                skip_feature_extraction=body.skip_feature_extraction
            )
            
            # Store results somewhere (e.g., job store)
            print(f"Workflow completed for {repo_id}")
            print(f"Results: {results}")
            
        except Exception as e:
            print(f"Workflow failed for {repo_id}: {e}")
            import traceback
            traceback.print_exc()
    
    background_tasks.add_task(run_workflow)
    
    return success_response(request, {
        'repo_id': repo_id,
        'status': 'started',
        'message': 'Product analysis workflow started in background'
    })