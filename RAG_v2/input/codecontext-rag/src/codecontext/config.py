import os
from dataclasses import dataclass


def _bool(val: str | None, default: bool) -> bool:
    if val is None:
        return default
    return val.lower() in {"1", "true", "yes", "y", "on"}


@dataclass
class Settings:
    app_env: str = os.getenv("APP_ENV", "development")
    app_port: int = int(os.getenv("APP_PORT", "8000"))
    log_level: str = os.getenv("LOG_LEVEL", "INFO")

    lancedb_path: str = os.getenv("LANCEDB_PATH", "./data/lancedb")
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")

    embedding_model: str = os.getenv("EMBEDDING_MODEL", "microsoft/codebert-base")
    openai_api_key: str | None = os.getenv("OPENAI_API_KEY")

    api_key_required: bool = _bool(os.getenv("API_KEY_REQUIRED"), False)
    api_key: str | None = os.getenv("API_KEY")
    jwt_secret: str = os.getenv("JWT_SECRET", "dev-secret")
    rate_limit_per_minute: int = int(os.getenv("RATE_LIMIT", "100"))

    max_recommendations: int = int(os.getenv("MAX_RECOMMENDATIONS", "20"))
    cache_ttl: int = int(os.getenv("CACHE_TTL", "3600"))
    enable_git_analysis: bool = _bool(os.getenv("ENABLE_GIT_ANALYSIS"), True)

    api_version: str = os.getenv("API_VERSION", "1.0.0")


settings = Settings()
