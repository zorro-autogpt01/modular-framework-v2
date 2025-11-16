from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.action import Action
from app.schemas.action import ActionCreate, ActionRun, ActionOut
from app.services.actions import action_service
from app.services.llm_gateway import llm_gateway

router = APIRouter()

@router.get("/actions")
async def list_actions(db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    items = db.execute(select(Action)).scalars().all()
    return {"items": [ActionOut(id=a.id, name=a.name, description=a.description, prompt=a.prompt, parameters_schema=a.parameters_schema) for a in items]}

@router.post("/actions")
async def create_action(data: ActionCreate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    a = action_service.create(db, data)
    return {"ok": True, "action": ActionOut(id=a.id, name=a.name, description=a.description, prompt=a.prompt, parameters_schema=a.parameters_schema)}

@router.post("/actions/{name}/run")
async def run_action(name: str, data: ActionRun, model_key: str | None = None, stream: bool = False, _: bool = Depends(require_auth)):
    # Lookup omitted for brevity: assume ephemeral prompt (or you can fetch by name)
    prompt = action_service.run_prompt(name, data.parameters if data else None, model_key)
    body = {"model": model_key or "gpt-4o-mini", "stream": stream, "messages": [{"role": "user", "content": prompt}]}
    if stream:
        from fastapi.responses import StreamingResponse
        return StreamingResponse(llm_gateway.chat_sse(body), media_type="text/event-stream")
    return await llm_gateway.chat_json(body)