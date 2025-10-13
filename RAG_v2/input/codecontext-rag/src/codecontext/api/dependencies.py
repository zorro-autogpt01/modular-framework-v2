from fastapi import Depends, Header, HTTPException, Request, status
from typing import Optional
from ..config import settings


def authorize(authorization: Optional[str] = Header(default=None)) -> None:
    if not settings.api_key_required:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={
            "code": "UNAUTHORIZED",
            "message": "Invalid or missing API key",
        })
    token = authorization.split(" ", 1)[1].strip()
    if not settings.api_key or token != settings.api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={
            "code": "UNAUTHORIZED",
            "message": "Invalid API key",
        })


def get_repo_store(request: Request):
    return request.app.state.repo_store


def get_job_store(request: Request):
    return request.app.state.job_store
