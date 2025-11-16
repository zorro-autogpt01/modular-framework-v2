from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.conversation import Conversation
from app.models.message import Message
from app.schemas.message import MessageCreate, MessageOut
from app.services.messages import message_service
from app.services.llm_gateway import llm_gateway
from app.utils.sse import sse_event
import json

router = APIRouter()

@router.get("/conversations/{cid}/messages")
async def list_messages(cid: str, limit: int = 100, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, cid)
    if not conv:
        raise HTTPException(404, detail="Conversation not found")
    items = message_service.get_thread(db, cid, limit=limit)
    def to_out(m: Message):
        return MessageOut(
            id=m.id, conversation_id=m.conversation_id, parent_id=m.parent_id,
            role=m.role, content=m.content, meta=m.meta, tokens=m.tokens, cost=m.cost
        )
    return {"items": [to_out(m) for m in items]}

@router.post("/conversations/{cid}/messages")
async def add_message(cid: str, data: MessageCreate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, cid)
    if not conv:
        raise HTTPException(404, detail="Conversation not found")
    msg = message_service.create(db, cid, data)
    return {"ok": True, "message": MessageOut(**{k: getattr(msg, k) for k in MessageOut.model_fields})}

@router.post("/conversations/{cid}/chat")
async def chat_complete(cid: str, data: MessageCreate, stream: bool = True, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, cid)
    if not conv:
        raise HTTPException(404, detail="Conversation not found")
    # Store user message
    user_msg = message_service.create(db, cid, data)

    # Build history for gateway
    stmt = select(Message).where(Message.conversation_id==cid).order_by(Message.id.asc())
    msgs = db.execute(stmt).scalars().all()
    history = [{"role": m.role, "content": m.content or ""} for m in msgs]
    if conv.system_prompt:
        history = [{"role": "system", "content": conv.system_prompt}] + history

    body = {
        "model": conv.model_key or "gpt-4o-mini",
        "messages": history,
        "stream": stream,
        "metadata": {"conversation_id": cid},
    }

    if not stream:
        res = await llm_gateway.chat_json(body)
        content = res.get("content") if isinstance(res, dict) else str(res)
        # Persist assistant message
        assistant = message_service.create(db, cid, MessageCreate(role="assistant", content=content))
        return {"content": content, "message": MessageOut(**{k: getattr(assistant, k) for k in MessageOut.model_fields})}

    async def event_stream():
        # Relay SSE and capture assembled text
        assembled = []
        async for line in llm_gateway.chat_sse(body):
            yield line + "\n"
            if line.startswith("data: "):
                try:
                    payload = json.loads(line[len("data: "):])
                    delta = payload.get("delta") or payload.get("content") or ""
                    if isinstance(delta, str):
                        assembled.append(delta)
                except Exception:
                    pass
        # After stream, save assistant message
        content = ''.join(assembled).strip()
        message_service.create(db, cid, MessageCreate(role="assistant", content=content))
        yield sse_event(event="done", data="{}").encode()

    return StreamingResponse(event_stream(), media_type="text/event-stream")