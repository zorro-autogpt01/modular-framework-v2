from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.conversation import Conversation
from app.models.message import Message
from app.models.branch import Branch
from app.schemas.branch import BranchCreate, BranchOut
from app.services.branches import branch_service

router = APIRouter()

@router.get("/conversations/{cid}/branches")
async def list_branches(cid: str, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    rows = db.execute(select(Branch).where(Branch.conversation_id == cid)).scalars().all()
    return {"items": [BranchOut(id=b.id, conversation_id=b.conversation_id, name=b.name, root_message_id=b.root_message_id, meta=b.meta) for b in rows]}

@router.post("/branches")
async def create_branch(data: BranchCreate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    conv = db.get(Conversation, data.conversation_id)
    if not conv:
        raise HTTPException(404, detail="Conversation not found")
    if data.root_message_id and not db.get(Message, data.root_message_id):
        raise HTTPException(404, detail="Root message not found")
    br = branch_service.create(db, data)
    return {"ok": True, "branch": BranchOut(id=br.id, conversation_id=br.conversation_id, name=br.name, root_message_id=br.root_message_id, meta=br.meta)}