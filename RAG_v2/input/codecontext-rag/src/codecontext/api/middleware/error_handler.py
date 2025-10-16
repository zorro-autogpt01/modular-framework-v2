# src/codecontext/api/middleware/error_handler.py
from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import traceback
from ...utils.responses import error_response
from ...utils.logging import get_logger

logger = get_logger(__name__)


class ErrorHandlingMiddleware(BaseHTTPMiddleware):
    """Global error handling middleware with user-friendly messages"""
    
    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            return response
        except Exception as exc:
            return self._handle_exception(request, exc)
    
    def _handle_exception(self, request: Request, exc: Exception) -> JSONResponse:
        """Convert exceptions to user-friendly JSON responses"""
        
        # Log the full error
        logger.error(f"Error handling {request.method} {request.url}: {exc}", exc_info=True)
        
        # Determine error type and message
        error_code = "INTERNAL_ERROR"
        error_message = "An unexpected error occurred"
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
        details = {}
        
        # Parse specific error types
        if isinstance(exc, ValueError):
            error_code = "INVALID_VALUE"
            error_message = str(exc)
            status_code = status.HTTP_400_BAD_REQUEST
            
        elif isinstance(exc, KeyError):
            error_code = "MISSING_KEY"
            error_message = f"Required key not found: {str(exc)}"
            status_code = status.HTTP_400_BAD_REQUEST
            
        elif isinstance(exc, FileNotFoundError):
            error_code = "FILE_NOT_FOUND"
            error_message = f"File not found: {str(exc)}"
            status_code = status.HTTP_404_NOT_FOUND
            
        elif isinstance(exc, PermissionError):
            error_code = "PERMISSION_DENIED"
            error_message = "Permission denied"
            status_code = status.HTTP_403_FORBIDDEN
            
        elif isinstance(exc, TimeoutError):
            error_code = "TIMEOUT"
            error_message = "Operation timed out"
            status_code = status.HTTP_504_GATEWAY_TIMEOUT
            
        elif "connection" in str(exc).lower():
            error_code = "CONNECTION_ERROR"
            error_message = "Failed to connect to external service"
            status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            details = {"service": self._detect_service(exc)}
            
        elif "embedding" in str(exc).lower():
            error_code = "EMBEDDING_ERROR"
            error_message = "Failed to generate embeddings"
            status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
            details = {"hint": "Check LLM Gateway connection"}
            
        elif "vector" in str(exc).lower() or "lancedb" in str(exc).lower():
            error_code = "VECTOR_STORE_ERROR"
            error_message = "Vector store operation failed"
            status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
            details = {"hint": "Check LanceDB connection"}
            
        elif "redis" in str(exc).lower() or "cache" in str(exc).lower():
            error_code = "CACHE_ERROR"
            error_message = "Cache operation failed (continuing without cache)"
            status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
            details = {"hint": "Check Redis connection", "non_fatal": True}
        
        # Include stack trace in development
        import os
        if os.getenv("APP_ENV") == "development":
            details["traceback"] = traceback.format_exc()
        
        # Create error response
        body = error_response(
            request,
            code=error_code,
            message=error_message,
            details=details,
            status_code=status_code
        )
        
        return JSONResponse(
            status_code=status_code,
            content=body
        )
    
    def _detect_service(self, exc: Exception) -> str:
        """Detect which service caused the connection error"""
        exc_str = str(exc).lower()
        if "llm" in exc_str or "gateway" in exc_str:
            return "LLM Gateway"
        elif "github" in exc_str or "hub" in exc_str:
            return "GitHub Hub"
        elif "redis" in exc_str:
            return "Redis"
        elif "lancedb" in exc_str:
            return "LanceDB"
        else:
            return "Unknown"


class ValidationErrorHandler:
    """Custom validation error handler for better messages"""
    
    @staticmethod
    def format_validation_error(errors: list) -> dict:
        """Format Pydantic validation errors into user-friendly messages"""
        formatted_errors = []
        
        for error in errors:
            field = ".".join(str(x) for x in error.get("loc", []))
            message = error.get("msg", "")
            error_type = error.get("type", "")
            
            formatted_errors.append({
                "field": field,
                "message": message,
                "type": error_type
            })
        
        return {
            "validation_errors": formatted_errors,
            "total_errors": len(formatted_errors)
        }