from fastapi import APIRouter, Depends
from app.api.deps import require_auth
from app.services.webhooks import deliver

router = APIRouter()

@router.post("/webhooks/test")
async def webhook_test(url: str, _: bool = Depends(require_auth)):
    await deliver(url, "test", {"hello": "world"})
    return {"ok": True}