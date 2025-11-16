from pydantic import BaseModel

class TemplateCreate(BaseModel):
    name: str
    description: str | None = None
    template: str

class TemplateOut(BaseModel):
    id: int
    name: str
    description: str | None
    template: str