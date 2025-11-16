from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.message import Message
from app.services.context_ops import auto_optimize

router = APIRouter()

@router.post("/conversations/{cid}/context/auto-optimize")
async def context_auto_optimize(cid: str, model_key: str | None = None, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    msgs = db.execute(select(Message).where(Message.conversation_id==cid).order_by(Message.id.asc())).scalars().all()
    compact = [{"id": m.id, "role": m.role, "content": (m.content or "")[:2000]} for m in msgs]
    res = await auto_optimize(compact, model_key)
    return {"ok": True, "result": res}

@router.post("/conversations/{cid}/context/manual-apply")
async def context_manual_apply(cid: str, summary: str | None = None, keep_ids: list[int] | None = None, drop_ids: list[int] | None = None, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    # Simplest application: insert a synthetic summary message and optionally delete drop_ids
    if summary:
        from app.schemas.message import MessageCreate
        from app.services.messages import message_service
        message_service.create(db, cid, MessageCreate(role="system", content=f"SUMMARY: {summary}"))
    if drop_ids:
        for mid in drop_ids:
            m = db.get(Message, mid)
            if m and m.conversation_id == cid:
                db.delete(m)
        db.commit()
    return {"ok": True}