from typing import Iterable
from app.services.llm_gateway import llm_gateway

CONTEXT_OPTIMIZER_TEMPLATE = (
    "You are a context compressor. Given a sequence of messages, produce a compact summary that preserves intent, decisions, and TODOs. "
    "Return JSON with keys: summary (string), keep_ids (array of ids to keep verbatim), drop_ids (array of ids to drop), notes (string)."
)

async def auto_optimize(messages: list[dict], model_key: str | None = None) -> dict:
    body = {
        "model": model_key or "gpt-4o-mini",
        "stream": False,
        "messages": [
            {"role": "system", "content": CONTEXT_OPTIMIZER_TEMPLATE},
            {"role": "user", "content": f"Messages: {messages}"},
        ],
    }
    res = await llm_gateway.chat_json(body)
    # Expecting JSON content; if raw string, wrap.
    out = res.get("content") if isinstance(res, dict) else res
    try:
        import json
        return json.loads(out)
    except Exception:
        return {"summary": str(out), "keep_ids": [], "drop_ids": [], "notes": "parser-fallback"}