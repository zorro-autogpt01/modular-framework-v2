import os
from dataclasses import dataclass
from typing import Optional

def _bool(val: str | None, default: bool) -> bool:
    if val is None:
        return default
    return val.lower() in {"1", "true", "yes", "y", "on"}

def _split_list(val: str | None) -> list[str]:
    if not val:
        return []
    parts = []
    for line in val.splitlines():
        parts.extend([p.strip() for p in line.split(";") if p.strip()])
    return parts

@dataclass
class Settings:
    # Core settings
    app_env: str = os.getenv("APP_ENV", "development")
    app_port: int = int(os.getenv("APP_PORT", "8000"))
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    api_version: str = os.getenv("API_VERSION", "1.0.0")

    # Storage
    lancedb_path: str = os.getenv("LANCEDB_PATH", "./data/lancedb")
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")

    # Security
    api_key_required: bool = _bool(os.getenv("API_KEY_REQUIRED"), False)
    api_key: str | None = os.getenv("API_KEY")
    jwt_secret: str = os.getenv("JWT_SECRET", "dev-secret")
    rate_limit_per_minute: int = int(os.getenv("RATE_LIMIT", "100"))

    # Features
    max_recommendations: int = int(os.getenv("MAX_RECOMMENDATIONS", "20"))
    cache_ttl: int = int(os.getenv("CACHE_TTL", "3600"))
    enable_git_analysis: bool = _bool(os.getenv("ENABLE_GIT_ANALYSIS"), True)
    
    # GitHub Hub Integration
    github_hub_url: str = os.getenv("GITHUB_HUB_URL", "http://localhost:3002")
    github_hub_enabled: bool = _bool(os.getenv("GITHUB_HUB_ENABLED"), True)
    github_default_conn: str | None = os.getenv("GITHUB_DEFAULT_CONN")
    
    # LLM Gateway Integration
    llm_gateway_url: str = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:3010")
    llm_gateway_enabled: bool = _bool(os.getenv("LLM_GATEWAY_ENABLED"), True)
    llm_gateway_model: str = os.getenv("LLM_GATEWAY_MODEL", "gpt-4o-mini")
    
    # Embeddings - Use LLM Gateway by default
    use_llm_gateway_embeddings: bool = _bool(os.getenv("USE_LLM_GATEWAY_EMBEDDINGS"), True)
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    embedding_dimensions: Optional[int] = int(os.getenv("EMBEDDING_DIMENSIONS")) if os.getenv("EMBEDDING_DIMENSIONS") else None
    
    # Legacy local embeddings (fallback)
    local_embedding_model: str = os.getenv("LOCAL_EMBEDDING_MODEL", "microsoft/codebert-base")
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY")

    # Index metadata persistence
    index_meta_path: str = os.getenv("INDEX_META_PATH", "./data/index_meta")

    # Neo4j (optional)
    neo4j_enabled: bool = _bool(os.getenv("NEO4J_ENABLED"), False)
    neo4j_url: str = os.getenv("NEO4J_URL", "bolt://localhost:7687")
    neo4j_user: str = os.getenv("NEO4J_USER", "neo4j")
    neo4j_password: str = os.getenv("NEO4J_PASSWORD", "password")

    # Pre-commit hooks for apply-patch
    pre_commit_hooks: list[str] = None

    # Local reranker (cross-encoder)
    reranker_enabled: bool = _bool(os.getenv("RERANKER_ENABLED"), True)
    reranker_model: str = os.getenv("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
    reranker_topk: int = int(os.getenv("RERANKER_TOPK", "50"))

    # Agentic retrieval
    agentic_default: bool = _bool(os.getenv("AGENTIC_DEFAULT"), False)
    agentic_max_iters: int = int(os.getenv("AGENTIC_MAX_ITERS", "2"))

    # Tests
    test_cmd: str = os.getenv("TEST_CMD", "pytest -q")

    # Feature extraction
    enable_feature_extraction: bool = _bool(os.getenv("ENABLE_FEATURE_EXTRACTION"), True)

    def __post_init__(self):
        self.pre_commit_hooks = _split_list(os.getenv("PRE_COMMIT_HOOKS", ""))

settings = Settings()