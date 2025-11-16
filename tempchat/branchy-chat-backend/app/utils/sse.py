from fastapi import Response
from typing import AsyncGenerator

SSE_HEADERS = {"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}

def sse_event(event: str | None = None, data: str = "") -> str:
    out = []
    if event:
        out.append(f"event: {event}")
    for line in data.splitlines() or [""]:
        out.append(f"data: {line}")
    out.append("")
    return "\n".join(out)

class SSE(Response):
    media_type = "text/event-stream"