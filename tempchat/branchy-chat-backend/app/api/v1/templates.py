from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.api.deps import db_session, require_auth
from app.models.template import Template
from app.schemas.template import TemplateCreate, TemplateOut

router = APIRouter()

@router.get("/templates")
async def list_templates(db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    items = db.execute(select(Template)).scalars().all()
    return {"items": [TemplateOut(id=t.id, name=t.name, description=t.description, template=t.template) for t in items]}

@router.post("/templates")
async def create_template(data: TemplateCreate, db: Session = Depends(db_session), _: bool = Depends(require_auth)):
    t = Template(name=data.name, description=data.description, template=data.template)
    db.add(t); db.commit(); db.refresh(t)
    return {"ok": True, "template": TemplateOut(id=t.id, name=t.name, description=t.description, template=t.template)}