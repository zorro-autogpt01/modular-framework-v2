from fastapi import Depends, HTTPException, Header
from app.core.config import settings

async def api_key_auth(x_api_key: str | None = Header(default=None)):
    if settings.API_KEY and x_api_key == settings.API_KEY:
        return True
    raise HTTPException(status_code=401, detail="Invalid or missing API key")