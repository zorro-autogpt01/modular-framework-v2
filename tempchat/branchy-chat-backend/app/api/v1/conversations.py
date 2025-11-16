from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.conversation import Conversation
from app.schemas.conversation import ConversationCreate, ConversationUpdate, ConversationOut
from app.services.conversations import conversation_service

router = APIRouter()

@router.get("/conversations")
async def list_conversations(limit: int = 50, q: str | None = None, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    stmt = select(Conversation)
    items = db.execute(stmt).scalars().all()
    items = items[:limit]
    return {"items": [ConversationOut(**{k: getattr(i, k) for k in ConversationOut.model_fields}) for i in items]}

@router.post("/conversations")
async def create_conversation(data: ConversationCreate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = conversation_service.create(db, data)
    return {"ok": True, "conversation": ConversationOut(**{k: getattr(conv, k) for k in ConversationOut.model_fields})}

@router.get("/conversations/{id}")
async def get_conversation(id: str, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, id)
    if not conv:
        raise HTTPException(404, detail="Not found")
    return {"conversation": ConversationOut(**{k: getattr(conv, k) for k in ConversationOut.model_fields})}

@router.put("/conversations/{id}")
async def update_conversation(id: str, data: ConversationUpdate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, id)
    if not conv:
        raise HTTPException(404, detail="Not found")
    conv = conversation_service.update(db, conv, data)
    return {"ok": True, "conversation": ConversationOut(**{k: getattr(conv, k) for k in ConversationOut.model_fields})}

@router.delete("/conversations/{id}")
async def delete_conversation(id: str, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, id)
    if not conv:
        raise HTTPException(404, detail="Not found")
    conversation_service.delete(db, conv)
    return {"ok": True}