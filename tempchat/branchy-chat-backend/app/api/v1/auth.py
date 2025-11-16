from fastapi import APIRouter, Depends
from app.api.deps import require_auth

router = APIRouter()

@router.get("/whoami")
async def whoami(_: bool = Depends(require_auth)):
    return {"ok": True, "auth": "api-key"}