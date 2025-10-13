from fastapi import APIRouter, Depends, HTTPException, Request, Response, status, BackgroundTasks
from typing import Optional
from ...utils.responses import success_response
from ...api.dependencies import authorize, get_repo_store, get_job_store
from ...api.schemas.request import RegisterRepositoryRequest, IndexRequest

router = APIRouter(prefix="/repositories", tags=["Repositories"], dependencies=[Depends(authorize)])


@router.get("")
def list_repositories(request: Request, status: str = "all", page: int = 1, per_page: int = 20):
    repos = request.app.state.repo_store.list(status_filter=status)
    start = (page - 1) * per_page
    end = start + per_page
    data = {
        "repositories": repos[start:end],
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": len(repos),
            "pages": (len(repos) + per_page - 1) // per_page,
            "has_next": end < len(repos),
            "has_prev": start > 0,
        },
    }
    return success_response(request, data)


@router.post("", status_code=status.HTTP_201_CREATED)
def register_repository(request: Request, body: RegisterRepositoryRequest):
    repo = request.app.state.repo_store.create(body)
    return success_response(request, repo)


@router.get("/{repo_id}")
def get_repository(request: Request, repo_id: str):
    repo = request.app.state.repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "REPOSITORY_NOT_FOUND", "message": f"Repository {repo_id} not found"})
    return success_response(request, repo)


@router.delete("/{repo_id}")
def delete_repository(request: Request, repo_id: str):
    removed = request.app.state.repo_store.delete(repo_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "REPOSITORY_NOT_FOUND", "message": f"Repository {repo_id} not found"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{repo_id}/index", status_code=status.HTTP_202_ACCEPTED)
def index_repository(request: Request, repo_id: str, body: IndexRequest, background: BackgroundTasks):
    repo = request.app.state.repo_store.get(repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "REPOSITORY_NOT_FOUND", "message": f"Repository {repo_id} not found"})
    job = request.app.state.job_store.enqueue(repo_id, body.mode, body.options.model_dump() if body.options else {})
    # simulate background work
    background.add_task(request.app.state.job_store.simulate, job["job_id"]) 
    return success_response(request, {"job_id": job["job_id"], "status": job["status"], "estimated_duration": 180})


@router.get("/{repo_id}/index/status")
def get_index_status(request: Request, repo_id: str):
    status_data = request.app.state.job_store.status_for_repo(repo_id)
    if not status_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "No job found"})
    return success_response(request, status_data)
