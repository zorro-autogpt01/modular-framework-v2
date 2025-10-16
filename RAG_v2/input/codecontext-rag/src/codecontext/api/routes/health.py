from fastapi import APIRouter, Request
from ...utils.responses import success_response
from ...config import settings

router = APIRouter(prefix="", tags=["Health"])


@router.get("/health")
def health(request: Request):
    cache = getattr(request.app.state, "cache", None)
    redis_status = "disabled"
    try:
        if cache and hasattr(cache, "ping") and cache.ping():
            # If it's a Redis cache, it's connected; otherwise in-memory
            if cache.__class__.__name__ == "RedisCache":
                redis_status = "connected"
            else:
                redis_status = "in-memory"
        else:
            redis_status = "unavailable"
    except Exception:
        redis_status = "error"

    data = {
        "status": "healthy",
        "version": settings.api_version,
        "uptime": request.app.state.uptime_seconds(),
        "dependencies": {
            "lancedb": "connected",
            "redis": redis_status,
            "git": "available",
        },
    }
    return success_response(request, data)