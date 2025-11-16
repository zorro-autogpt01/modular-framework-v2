from sqlalchemy import Integer, String, JSON, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base

class Branch(Base):
    __tablename__ = "branches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    root_message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"))
    meta: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))