from sqlalchemy.orm import Session
from sqlalchemy import select
from app.models.message import Message
from app.schemas.message import MessageCreate

class MessageService:
    def create(self, db: Session, conversation_id: str, data: MessageCreate) -> Message:
        msg = Message(
            conversation_id=conversation_id,
            parent_id=data.parent_id,
            role=data.role,
            content=data.content,
            meta=data.meta or {},
        )
        db.add(msg); db.commit(); db.refresh(msg)
        return msg

    def get_thread(self, db: Session, conversation_id: str, limit: int = 100):
        stmt = select(Message).where(Message.conversation_id==conversation_id).order_by(Message.id.asc()).limit(limit)
        return db.execute(stmt).scalars().all()

message_service = MessageService()