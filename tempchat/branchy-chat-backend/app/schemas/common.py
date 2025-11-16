from pydantic import BaseModel

class Page(BaseModel):
    limit: int = 50
    before: int | None = None