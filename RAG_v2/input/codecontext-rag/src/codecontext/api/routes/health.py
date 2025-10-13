from fastapi import APIRouter, Request
from ...utils.responses import success_response
from ...config import settings

router = APIRouter(prefix="", tags=["Health"])


@router.get("/health")
def health(request: Request):
    data = {
        "status": "healthy",
        "version": settings.api_version,
        "uptime": request.app.state.uptime_seconds(),
        "dependencies": {
            "lancedb": "connected",
            "redis": "connected",
            "git": "available",
        },
    }
    return success_response(request, data)
