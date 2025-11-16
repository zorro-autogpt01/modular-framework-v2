from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    DATABASE_URL: str
    REDIS_URL: str | None = None
    API_KEY: str = "changeme"
    LLM_GATEWAY_BASE_URL: str
    LLM_GATEWAY_INTERNAL_TOKEN: str | None = None
    LOG_LEVEL: str = "INFO"

    class Config:
        env_file = ".env"

settings = Settings()