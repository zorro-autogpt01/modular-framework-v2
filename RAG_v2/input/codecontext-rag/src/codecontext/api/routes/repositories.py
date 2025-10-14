# src/codecontext/api/routes/repositories.py
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status, BackgroundTasks
from pydantic import BaseModel
from datetime import datetime
import httpx
import os
import tempfile
import zipfile
import shutil
from typing import Optional

from ...utils.logging import get_logger
from ...config import settings
from ...utils.responses import success_response
from ...api.dependencies import authorize, get_repo_store, get_job_store
from ...api.schemas.request import RegisterRepositoryRequest, IndexRequest

router = APIRouter(prefix="/repositories", tags=["Repositories"], dependencies=[Depends(authorize)])
logger = get_logger(__name__)


class AddRepositoryRequest(BaseModel):
    """Request to add a repository"""
    owner: str
    name: str
    connection_id: Optional[str] = None  # GitHub Hub connection ID
    branch: str = "main"
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
    Add a repository from GitHub Hub and optionally start indexing
    
    This will:
    1. Fetch repository metadata from GitHub Hub
    2. Clone/download the repository
    3. Start indexing in the background if auto_index=True
    """
    repo_store = request.app.state.repo_store
    indexer = request.app.state.indexer
    job_store = request.app.state.job_store
    
    full_name = f"{repo_request.owner}/{repo_request.name}"
    repo_id = full_name.replace("/", "_")
    
    # Check if already exists
    existing = repo_store.get(repo_id)
    if existing:
        raise HTTPException(
            status_code=400, 
            detail=f"Repository {full_name} already exists. Use /{repo_id}/reindex to re-index."
        )
    
    try:
        # Fetch repository from GitHub Hub
        connection_id = repo_request.connection_id or settings.github_default_conn
        if not connection_id:
            raise HTTPException(
                status_code=400, 
                detail="No connection_id provided and GITHUB_DEFAULT_CONN not set"
            )
        
        logger.info(f"Fetching repository {full_name} from GitHub Hub...")
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get repository details from GitHub Hub
            response = await client.get(
                f"{settings.github_hub_url}/api/repositories/{repo_request.owner}/{repo_request.name}",
                params={"connection_id": connection_id}
            )
            response.raise_for_status()
            github_repo = response.json()
            
            # Download repository archive
            logger.info(f"Downloading repository archive for {full_name}...")
            archive_response = await client.get(
                f"{settings.github_hub_url}/api/repositories/{repo_request.owner}/{repo_request.name}/archive",
                params={
                    "connection_id": connection_id,
                    "ref": repo_request.branch
                },
                timeout=120.0  # Longer timeout for large repos
            )
            archive_response.raise_for_status()
            
            # Save to persistent location (not temp)
            repos_base = os.getenv("REPOS_PATH", "./data/repos")
            os.makedirs(repos_base, exist_ok=True)
            
            repo_dir = os.path.join(repos_base, repo_id)
            os.makedirs(repo_dir, exist_ok=True)
            
            archive_path = os.path.join(repo_dir, "repo.zip")
            
            with open(archive_path, "wb") as f:
                f.write(archive_response.content)
            
            logger.info(f"Extracting repository {full_name}...")
            
            # Extract
            extract_dir = os.path.join(repo_dir, "source")
            with zipfile.ZipFile(archive_path, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
            
            # Find the actual repo directory (GitHub archives have a wrapper folder)
            extracted_contents = os.listdir(extract_dir)
            if len(extracted_contents) == 1:
                repo_path = os.path.join(extract_dir, extracted_contents[0])
            else:
                repo_path = extract_dir
            
            # Clean up archive
            os.remove(archive_path)
            
            # Create repository entry
            repo_data = {
                "id": repo_id,
                "owner": repo_request.owner,
                "name": repo_request.name,
                "full_name": full_name,
                "branch": repo_request.branch,
                "status": "pending",
                "connection_id": connection_id,
                "local_path": repo_path,
                "source_path": repo_path,  # For compatibility
                "github_url": github_repo.get("html_url"),
                "description": github_repo.get("description"),
                "language": github_repo.get("language"),
                "stars": github_repo.get("stargazers_count"),
                "size": github_repo.get("size"),
                "created_at": utc_now_iso()
            }
            
            # Store in repo store
            repo_store.add(repo_data)
            
            logger.info(f"Repository {full_name} added successfully")
            
            # Start indexing in background if requested
            if repo_request.auto_index:
                logger.info(f"Starting background indexing for {full_name}")
                
                # Create job
                job = job_store.enqueue(repo_id, "full", {})
                
                # Update repo status
                repo_store.update(repo_id, {"status": "indexing"})
                
                # Start indexing task
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
                owner=repo_request.owner,
                name=repo_request.name,
                full_name=full_name,
                branch=repo_request.branch,
                status="indexing" if repo_request.auto_index else "pending",
                indexed_at=None
            )
    
    except httpx.HTTPError as e:
        logger.error(f"Failed to fetch repository from GitHub Hub: {e}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch repository from GitHub Hub: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Failed to add repository: {e}", exc_info=True)
        
        # Cleanup on failure
        if 'repo_id' in locals():
            try:
                repo_store.delete(repo_id)
                if 'repo_dir' in locals():
                    shutil.rmtree(repo_dir, ignore_errors=True)
            except:
                pass
        
        raise HTTPException(status_code=500, detail=str(e))


async def index_repository_task(indexer, repo_store, job_store, job_id: str, repo_id: str, repo_path: str):
    """Background task to index a repository"""
    try:
        logger.info(f"Starting indexing for repository {repo_id} at {repo_path}")
        
        # Update job status
        job_store.update_job(job_id, {"status": "running", "started_at": utc_now_iso()})
        
        # Run indexing
        result = await indexer.index_repository(repo_id, repo_path)
        
        # Update job as completed
        job_store.update_job(job_id, {
            "status": "completed",
            "completed_at": utc_now_iso(),
            "result": result
        })
        
        # Update repo status
        repo_store.update(repo_id, {
            "status": "indexed",
            "indexed_at": utc_now_iso(),
            "last_indexed_at": utc_now_iso(),
            "statistics": {
                "total_files": result.get("files_processed", 0),
                "indexed_files": result.get("entities_indexed", 0),
                "chunks": result.get("chunks_created", 0)
            }
        })
        
        logger.info(f"Repository {repo_id} indexed successfully: {result}")
        
    except Exception as e:
        logger.error(f"Failed to index repository {repo_id}: {e}", exc_info=True)
        
        # Update job as failed
        job_store.update_job(job_id, {
            "status": "failed",
            "completed_at": utc_now_iso(),
            "error": str(e)
        })
        
        # Update repo status
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
    
    # Cleanup local files if they exist
    if repo.get("local_path"):
        try:
            # Remove the entire repo directory
            repo_dir = os.path.dirname(repo["local_path"])
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
    
    # Create new job
    job = job_store.enqueue(repo_id, "full", {})
    
    # Update status
    repo_store.update(repo_id, {"status": "indexing"})
    
    # Start indexing in background
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