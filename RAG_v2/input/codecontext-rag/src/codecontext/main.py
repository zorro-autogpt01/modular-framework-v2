from fastapi import FastAPI, Request
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
import uuid
import time
from .config import settings
from .utils.logging import configure_logging, get_logger
from .utils.responses import error_response
from .api.routes import health, repositories, recommendations, dependencies, impact_analysis, search
from .storage.inmemory import InMemoryRepositoryStore, InMemoryJobStore
from .core.parser import CodeParser
from .core.embedder import LLMGatewayEmbedder  # Only import what you need
from .core.ranker import RankingEngine
from .storage.vector_store import VectorStore
from .indexing.indexer import Indexer

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


# Configure logging
configure_logging(settings.log_level)

# Create FastAPI app
app = FastAPI(
    title="CodeContext RAG API", 
    version=settings.api_version, 
    openapi_url="/openapi.json"
)

# Initialize core components
vector_store = VectorStore(settings.lancedb_path)
parser = CodeParser()

# Initialize embedder with LLM Gateway
if settings.use_llm_gateway_embeddings:
    logger.info("Using LLM Gateway for embeddings")
    embedder = LLMGatewayEmbedder(
        gateway_url=settings.llm_gateway_url,
        model=settings.embedding_model,
        #dimensions=settings.embedding_dimensions
        dimensions=1536
    )
else:
    logger.info("Using local embeddings (fallback)")
    # You could implement a local embedder here if needed
    embedder = LLMGatewayEmbedder(
        gateway_url=settings.llm_gateway_url,
        model=settings.embedding_model,
        #dimensions=settings.embedding_dimensions
        dimensions=1536
    )

ranker = RankingEngine()

# Initialize stores
repo_store = InMemoryRepositoryStore()
job_store = InMemoryJobStore(repo_store)

# Initialize indexer
indexer = Indexer(vector_store, parser, embedder)
indexer.repo_store = repo_store  # Attach for incremental indexing

# Attach to app state
app.state.vector_store = vector_store
app.state.parser = parser
app.state.embedder = embedder
app.state.ranker = ranker
app.state.indexer = indexer
app.state.repo_store = repo_store
app.state.job_store = job_store
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

# Include routers
app.include_router(health.router)
app.include_router(repositories.router)
app.include_router(recommendations.router)
app.include_router(dependencies.router)
app.include_router(impact_analysis.router)
app.include_router(search.router)  # Only include once!


# Exception handlers
@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    body = error_response(
        request, 
        code="NOT_FOUND", 
        message="Requested resource not found"
    )
    return JSONResponse(status_code=404, content=body)


@app.exception_handler(422)
async def validation_error_handler(request: Request, exc):
    body = error_response(
        request, 
        code="INVALID_REQUEST", 
        message="Validation error", 
        details={"errors": str(exc)}
    )
    return JSONResponse(status_code=400, content=body)


@app.get("/")
async def root(request: Request):
    return {
        "message": "CodeContext RAG API", 
        "version": settings.api_version,
        "status": "running"
    }


# Lifecycle events
@app.on_event("startup")
async def startup_event():
    logger.info("CodeContext RAG API starting up...")
    logger.info(f"LLM Gateway URL: {settings.llm_gateway_url}")
    logger.info(f"Vector store path: {settings.lancedb_path}")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("CodeContext RAG API shutting down...")
    # Close embedder HTTP client
    await embedder.close()