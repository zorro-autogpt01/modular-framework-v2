from fastapi import APIRouter, Depends
from app.api.deps import require_auth
from app.services.llm_gateway import llm_gateway

router = APIRouter()

@router.get("/models")
async def list_models(_: bool = Depends(require_auth)):
    return await llm_gateway.list_models()

@router.post("/tokens")
async def token_count(body: dict, _: bool = Depends(require_auth)):
    return await llm_gateway.tokens(body)