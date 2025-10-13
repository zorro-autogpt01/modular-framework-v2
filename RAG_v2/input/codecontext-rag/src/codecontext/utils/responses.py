from typing import Any, Optional
from fastapi import Request, Response
from .time import utc_now_iso
from ..config import settings
import uuid


def success_response(request: Request, data: Any, response: Optional[Response] = None) -> dict:
    request_id = getattr(request.state, "request_id", None) or str(uuid.uuid4())
    if response is not None:
        response.headers["X-Request-Id"] = request_id
    return {
        "success": True,
        "data": data,
        "error": None,
        "metadata": {
            "timestamp": utc_now_iso(),
            "request_id": request_id,
            "version": settings.api_version,
        },
    }


def error_response(request: Request, code: str, message: str, details: Optional[dict] = None, status_code: int = 400, response: Optional[Response] = None) -> dict:
    request_id = getattr(request.state, "request_id", None) or str(uuid.uuid4())
    if response is not None:
        response.headers["X-Request-Id"] = request_id
    return {
        "success": False,
        "data": None,
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
        },
        "metadata": {
            "timestamp": utc_now_iso(),
            "request_id": request_id,
            "version": settings.api_version,
        },
    }
