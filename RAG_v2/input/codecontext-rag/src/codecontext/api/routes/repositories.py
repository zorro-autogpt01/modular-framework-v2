from fastapi import APIRouter, Depends, HTTPException, Request, Response, status, BackgroundTasks
from pydantic import BaseModel
from datetime import datetime
import httpx
import os
import subprocess
import shutil
from typing import Optional
from pathlib import Path

from ...utils.logging import get_logger
from ...config import settings
from ...utils.responses import success_response
from ...api.dependencies import authorize, get_repo_store, get_job_store

router = APIRouter(prefix="/repositories", tags=["Repositories"])  # Removed auth for now
logger = get_logger(__name__)


class AddRepositoryRequest(BaseModel):
    """Request to add a repository"""
    connection_id: str  # Required - the GitHub Hub connection ID
    branch: Optional[str] = None  # Optional - uses connection's default_branch if not specified
    auto_index: bool = True


class RepositoryResponse(BaseModel):
    """Repository information"""
    id: str
    owner: str
    name: str
    full_name: str
    branch: str
    status: str
    indexed_at: Optional[str] = None


def utc_now_iso() -> str:
    """Helper to get current UTC time as ISO string"""
    return datetime.utcnow().isoformat() + "Z"


def parse_repo_url(repo_url: str) -> tuple[str, str]:
    """Parse owner and repo from GitHub URL"""
    import re
    # Match: https://github.com/owner/repo or git@github.com:owner/repo
    match = re.search(r'github\.com[:/]([^/]+)/([^/\.]+)', repo_url)
    if match:
        return match.groups()
    raise ValueError(f"Could not parse owner/repo from: {repo_url}")


@router.get("", response_model=list[RepositoryResponse])
async def list_repositories(request: Request):
    """List all repositories"""
    repo_store = request.app.state.repo_store
    repos = repo_store.list()
    
    return [
        RepositoryResponse(
            id=r["id"],
            owner=r.get("owner", ""),
            name=r.get("name", ""),
            full_name=r.get("full_name", r["id"]),
            branch=r.get("branch", "main"),
            status=r.get("status", "unknown"),
            indexed_at=r.get("indexed_at")
        )
        for r in repos
    ]


@router.post("", response_model=RepositoryResponse)
async def add_repository(
    request: Request,
    repo_request: AddRepositoryRequest,
    background_tasks: BackgroundTasks
):
    """
    Add a repository from GitHub Hub connection and optionally start indexing
    """
    repo_store = request.app.state.repo_store
    indexer = request.app.state.indexer
    job_store = request.app.state.job_store
    
    connection_id = repo_request.connection_id
    
    try:
        logger.info(f"Fetching connection '{connection_id}' from GitHub Hub...")
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Get connection details from GitHub Hub
            response = await client.get(
                f"{settings.github_hub_url}/api/connections/{connection_id}"
            )
            
            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=f"Connection '{connection_id}' not found in GitHub Hub"
                )
            
            response.raise_for_status()
            connection = response.json()
            
            logger.info(f"Connection found: {connection}")
            
            # Extract repository information
            repo_url = connection.get("repo_url")
            if not repo_url:
                raise HTTPException(
                    status_code=400,
                    detail=f"Connection '{connection_id}' has no repo_url configured"
                )
            
            # Parse owner/repo from URL
            try:
                owner, repo_name = parse_repo_url(repo_url)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            
            # Determine branch
            branch = repo_request.branch or connection.get("default_branch") or "main"
            
            # Check if branch exists in connection
            available_branches = connection.get("branches", [])
            if available_branches and branch not in available_branches:
                raise HTTPException(
                    status_code=400,
                    detail=f"Branch '{branch}' not found. Available: {', '.join(available_branches)}"
                )
            
            # Generate repo_id
            full_name = f"{owner}/{repo_name}"
            repo_id = f"{connection_id}_{owner}_{repo_name}".replace("/", "_").replace(" ", "_")
            
            # Check if already exists
            existing = repo_store.get(repo_id)
            if existing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Repository {full_name} already exists with ID '{repo_id}'. Use /{repo_id}/reindex to re-index."
                )
            
            # Create repo directory
            repos_base = os.getenv("REPOS_PATH", "./data/repos")
            os.makedirs(repos_base, exist_ok=True)
            
            repo_dir = os.path.join(repos_base, repo_id)
            if os.path.exists(repo_dir):
                raise HTTPException(
                    status_code=400,
                    detail=f"Repository directory already exists: {repo_id}"
                )
            
            os.makedirs(repo_dir, exist_ok=True)
            repo_path = os.path.join(repo_dir, "source")
            
            # Clone the repository
            logger.info(f"Cloning repository: {repo_url} (branch: {branch}) -> {repo_path}")
            
            try:
                result = subprocess.run(
                    [
                        "git", "clone",
                        "--depth", "1",
                        "--branch", branch,
                        "--single-branch",
                        repo_url,
                        repo_path
                    ],
                    capture_output=True,
                    text=True,
                    timeout=300
                )
                
                if result.returncode != 0:
                    logger.error(f"Git clone failed: {result.stderr}")
                    shutil.rmtree(repo_dir, ignore_errors=True)
                    raise HTTPException(
                        status_code=500,
                        detail=f"Git clone failed: {result.stderr}"
                    )
                
                logger.info(f"Repository cloned successfully to {repo_path}")
                
            except subprocess.TimeoutExpired:
                shutil.rmtree(repo_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=500,
                    detail="Git clone timeout (5 minutes exceeded)"
                )
            except Exception as e:
                shutil.rmtree(repo_dir, ignore_errors=True)
                raise HTTPException(status_code=500, detail=f"Clone failed: {str(e)}")
            
            # Create repository entry
            repo_data = {
                "id": repo_id,
                "owner": owner,
                "name": repo_name,
                "full_name": full_name,
                "branch": branch,
                "status": "pending",
                "connection_id": connection_id,
                "local_path": repo_path,
                "source_path": repo_path,
                "github_url": repo_url.replace(".git", ""),
                "description": connection.get("description"),
                "created_at": utc_now_iso()
            }
            
            # Store in repo store
            repo_store.add(repo_data)
            logger.info(f"Repository {full_name} added successfully with ID: {repo_id}")
            
            # Start indexing in background if requested
            if repo_request.auto_index:
                logger.info(f"Starting background indexing for {full_name}")
                
                job = job_store.enqueue(repo_id, "full", {})
                repo_store.update(repo_id, {"status": "indexing"})
                
                background_tasks.add_task(
                    index_repository_task,
                    indexer=indexer,
                    repo_store=repo_store,
                    job_store=job_store,
                    job_id=job["job_id"],
                    repo_id=repo_id,
                    repo_path=repo_path
                )
            
            return RepositoryResponse(
                id=repo_id,
                owner=owner,
                name=repo_name,
                full_name=full_name,
                branch=branch,
                status="indexing" if repo_request.auto_index else "pending",
                indexed_at=None
            )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to add repository: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _summarize_index_result(result: dict | None) -> dict:
    """Convert indexer result to a JSON-serializable summary"""
    if not result:
        return {}
    dep = result.get("dependency_graph")
    graph_stats = None
    try:
        if dep and getattr(dep, "graph", None):
            g = dep.graph
            # Avoid heavy computation; simple stats only
            graph_stats = {
                "nodes": g.number_of_nodes(),
                "edges": g.number_of_edges(),
            }
            # Avoid calling find_circular_dependencies if graph is large
    except Exception:
        graph_stats = None

    return {
        "status": result.get("status"),
        "entities_indexed": result.get("entities_indexed"),
        "files_processed": result.get("files_processed"),
        "dependency_graph": graph_stats,
    }


async def index_repository_task(indexer, repo_store, job_store, job_id: str, repo_id: str, repo_path: str):
    """Background task to index a repository"""
    try:
        logger.info(f"Starting indexing for repository {repo_id} at {repo_path}")
        
        # Update job status
        job_store.update_job(job_id, {"status": "running", "started_at": utc_now_iso()})
        
        # Run indexing synchronously in executor (index() is not async)
        import asyncio
        loop = asyncio.get_event_loop()
        
        logger.info(f"Calling indexer.index(repo_id={repo_id}, repo_path={repo_path})")
        
        result = await loop.run_in_executor(
            None,
            indexer.index,
            repo_id,
            repo_path,
            "full",
            {}
        )
        
        logger.info(f"Indexing completed with result: {result}")
        
        # Update job as completed with JSON-safe summary only
        job_store.update_job(job_id, {
            "status": "completed",
            "completed_at": utc_now_iso(),
            "result": _summarize_index_result(result)
        })
        
        # Update repo status
        repo_store.update(repo_id, {
            "status": "indexed",
            "indexed_at": utc_now_iso(),
            "last_indexed_at": utc_now_iso(),
            "statistics": {
                "total_files": result.get("files_processed", 0) if result else 0,
                "indexed_files": result.get("entities_indexed", 0) if result else 0,
            }
        })
        
        logger.info(f"Repository {repo_id} indexed successfully")
        
    except Exception as e:
        logger.error(f"Failed to index repository {repo_id}: {e}", exc_info=True)
        
        job_store.update_job(job_id, {
            "status": "failed",
            "completed_at": utc_now_iso(),
            "error": str(e)
        })
        
        repo_store.update(repo_id, {
            "status": "error",
            "error": str(e)
        })


@router.get("/{repo_id}", response_model=RepositoryResponse)
async def get_repository(request: Request, repo_id: str):
    """Get repository details"""
    repo_store = request.app.state.repo_store
    repo = repo_store.get(repo_id)
    
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")
    
    return RepositoryResponse(
        id=repo["id"],
        owner=repo.get("owner", ""),
        name=repo.get("name", ""),
        full_name=repo.get("full_name", repo["id"]),
        branch=repo.get("branch", "main"),
        status=repo.get("status", "unknown"),
        indexed_at=repo.get("indexed_at")
    )


@router.delete("/{repo_id}")
async def delete_repository(request: Request, repo_id: str):
    """Delete a repository and its indexed data"""
    repo_store = request.app.state.repo_store
    vector_store = request.app.state.vector_store
    
    repo = repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")
    
    logger.info(f"Deleting repository {repo_id}")
    
    # Delete from vector store
    try:
        vector_store.delete_repository(repo_id)
    except Exception as e:
        logger.warning(f"Failed to delete from vector store: {e}")
    
    # Delete from repo store
    repo_store.delete(repo_id)
    
    # Cleanup local files
    if repo.get("local_path"):
        try:
            repo_dir = Path(repo["local_path"]).parent
            shutil.rmtree(repo_dir, ignore_errors=True)
            logger.info(f"Cleaned up local files for {repo_id}")
        except Exception as e:
            logger.warning(f"Failed to cleanup local files: {e}")
    
    return {"message": f"Repository {repo_id} deleted successfully"}


@router.post("/{repo_id}/reindex")
async def reindex_repository(
    request: Request,
    repo_id: str,
    background_tasks: BackgroundTasks
):
    """Trigger re-indexing of a repository"""
    repo_store = request.app.state.repo_store
    indexer = request.app.state.indexer
    job_store = request.app.state.job_store
    
    repo = repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")
    
    if not repo.get("local_path"):
        raise HTTPException(status_code=400, detail="Repository has no local path")
    
    logger.info(f"Re-indexing repository {repo_id}")
    
    job = job_store.enqueue(repo_id, "full", {})
    repo_store.update(repo_id, {"status": "indexing"})
    
    background_tasks.add_task(
        index_repository_task,
        indexer=indexer,
        repo_store=repo_store,
        job_store=job_store,
        job_id=job["job_id"],
        repo_id=repo_id,
        repo_path=repo["local_path"]
    )
    
    return {
        "message": f"Re-indexing started for {repo_id}",
        "job_id": job["job_id"]
    }


@router.get("/{repo_id}/index/status")
def get_index_status(request: Request, repo_id: str):
    """Get indexing status for a repository"""
    status_data = request.app.state.job_store.status_for_repo(repo_id)
    if not status_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, 
            detail={"code": "NOT_FOUND", "message": "No indexing job found for this repository"}
        )
    return success_response(request, status_data)

