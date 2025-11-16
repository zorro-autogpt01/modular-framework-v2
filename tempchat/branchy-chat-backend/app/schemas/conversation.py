from pydantic import BaseModel, Field
from typing import Any, Optional

class ConversationCreate(BaseModel):
    id: str
    title: Optional[str] = None
    system_prompt: Optional[str] = None
    model_key: Optional[str] = None
    meta: dict | None = None

class ConversationUpdate(BaseModel):
    title: Optional[str] = None
    system_prompt: Optional[str] = None
    model_key: Optional[str] = None
    meta: dict | None = None
    archived: Optional[bool] = None

class ConversationOut(BaseModel):
    id: str
    title: str | None
    system_prompt: str | None
    model_key: str | None
    meta: dict | None
    archived: bool