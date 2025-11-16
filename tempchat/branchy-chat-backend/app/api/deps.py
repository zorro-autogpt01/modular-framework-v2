from fastapi import Depends
from app.core.security import api_key_auth
from app.db.session import SessionLocal

async def require_auth(auth=Depends(api_key_auth)):
    return True

def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()