from pydantic import BaseModel

class ActionCreate(BaseModel):
    name: str
    description: str | None = None
    prompt: str
    parameters_schema: dict | None = None

class ActionRun(BaseModel):
    parameters: dict | None = None

class ActionOut(BaseModel):
    id: int
    name: str
    description: str | None
    prompt: str
    parameters_schema: dict | None