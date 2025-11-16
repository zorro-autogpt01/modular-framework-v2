from sqlalchemy.orm import Session
from app.models.action import Action
from app.schemas.action import ActionCreate

class ActionService:
    def create(self, db: Session, data: ActionCreate) -> Action:
        a = Action(name=data.name, description=data.description, prompt=data.prompt, parameters_schema=data.parameters_schema)
        db.add(a); db.commit(); db.refresh(a)
        return a

    def run_prompt(self, prompt: str, parameters: dict | None, model_key: str | None):
        # Compose chat with parameters embedded; actual LLM call is done in router for SSE or JSON
        if parameters:
            prompt = prompt.format(**parameters)
        return prompt

action_service = ActionService()