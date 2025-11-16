from fastapi import APIRouter
from app.api.v1 import health, auth, models_proxy, conversations, messages, branches, context, actions, templates, webhooks

api_router = APIRouter()
api_router.include_router(health.router, prefix="/v1", tags=["health"])
api_router.include_router(auth.router, prefix="/v1", tags=["auth"])
api_router.include_router(models_proxy.router, prefix="/v1", tags=["models"])
api_router.include_router(conversations.router, prefix="/v1", tags=["conversations"])
api_router.include_router(messages.router, prefix="/v1", tags=["messages"])
api_router.include_router(branches.router, prefix="/v1", tags=["branches"])
api_router.include_router(context.router, prefix="/v1", tags=["context"])
api_router.include_router(actions.router, prefix="/v1", tags=["actions"])
api_router.include_router(templates.router, prefix="/v1", tags=["templates"])
api_router.include_router(webhooks.router, prefix="/v1", tags=["webhooks"])