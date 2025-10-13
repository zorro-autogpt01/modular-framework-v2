from fastapi import FastAPI, Request
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
import uuid
import time
from .config import settings
from .utils.logging import configure_logging, get_logger
from .utils.responses import error_response
from .api.routes import health, repositories, recommendations, dependencies, impact_analysis, search, search
from .storage.inmemory import InMemoryRepositoryStore, InMemoryJobStore

logger = get_logger(__name__)


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers.setdefault("X-RateLimit-Limit", str(settings.rate_limit_per_minute))
        # NOTE: Implement real rate limiting later
        response.headers.setdefault("X-RateLimit-Remaining", str(settings.rate_limit_per_minute))
        return response


start_time = time.time()


def uptime_seconds() -> int:
    return int(time.time() - start_time)


configure_logging(settings.log_level)
app = FastAPI(title="CodeContext RAG API", version=settings.api_version, openapi_url="/openapi.json")

# Attach app state
app.state.repo_store = InMemoryRepositoryStore()
app.state.job_store = InMemoryJobStore(app.state.repo_store)
app.state.uptime_seconds = uptime_seconds

# Middleware
app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(health.router)
app.include_router(repositories.router)
app.include_router(recommendations.router)
app.include_router(dependencies.router)
app.include_router(impact_analysis.router)
app.include_router(search.router)

app.include_router(search.router)



@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    body = error_response(request, code="NOT_FOUND", message="Requested resource not found")
    return JSONResponse(status_code=404, content=body)


@app.exception_handler(422)
async def validation_error_handler(request: Request, exc):
    body = error_response(request, code="INVALID_REQUEST", message="Validation error", details={"errors": str(exc)})
    return JSONResponse(status_code=400, content=body)


@app.get("/")
async def root(request: Request):
    return {"message": "CodeContext RAG API", "version": settings.api_version}
