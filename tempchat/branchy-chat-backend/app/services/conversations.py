from sqlalchemy.orm import Session
from app.models.conversation import Conversation
from app.schemas.conversation import ConversationCreate, ConversationUpdate
from datetime import datetime

class ConversationService:
    def create(self, db: Session, data: ConversationCreate) -> Conversation:
        conv = Conversation(
            id=data.id,
            title=data.title,
            system_prompt=data.system_prompt,
            model_key=data.model_key,
            meta=data.meta or {},
        )
        db.add(conv)
        db.commit(); db.refresh(conv)
        return conv

    def update(self, db: Session, conv: Conversation, data: ConversationUpdate) -> Conversation:
        for f in ["title", "system_prompt", "model_key", "meta", "archived"]:
            v = getattr(data, f)
            if v is not None:
                setattr(conv, f, v)
        conv.updated_at = datetime.utcnow()
        db.add(conv); db.commit(); db.refresh(conv)
        return conv

    def delete(self, db: Session, conv: Conversation):
        db.delete(conv); db.commit()

conversation_service = ConversationService()