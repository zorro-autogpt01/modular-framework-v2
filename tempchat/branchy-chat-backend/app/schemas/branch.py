from pydantic import BaseModel

class BranchCreate(BaseModel):
    conversation_id: str
    name: str
    root_message_id: int | None = None
    meta: dict | None = None

class BranchOut(BaseModel):
    id: int
    conversation_id: str
    name: str
    root_message_id: int | None
    meta: dict | None