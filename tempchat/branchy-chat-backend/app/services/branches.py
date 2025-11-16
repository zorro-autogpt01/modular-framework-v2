from sqlalchemy.orm import Session
from app.models.branch import Branch
from app.schemas.branch import BranchCreate

class BranchService:
    def create(self, db: Session, data: BranchCreate) -> Branch:
        br = Branch(
            conversation_id=data.conversation_id,
            name=data.name,
            root_message_id=data.root_message_id,
            meta=data.meta or {},
        )
        db.add(br); db.commit(); db.refresh(br)
        return br

branch_service = BranchService()