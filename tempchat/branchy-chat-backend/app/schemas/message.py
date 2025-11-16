from pydantic import BaseModel
from typing import Any

class MessageCreate(BaseModel):
    parent_id: int | None = None
    role: str
    content: str | None = None
    meta: dict | None = None

class MessageOut(BaseModel):
    id: int
    conversation_id: str
    parent_id: int | None
    role: str
    content: str | None
    meta: dict | None
    tokens: int | None
    cost: float | None