from sqlalchemy import Integer, String, Text, JSON, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base

class Action(Base):
    __tablename__ = "actions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    prompt: Mapped[str] = mapped_column(Text)
    parameters_schema: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))