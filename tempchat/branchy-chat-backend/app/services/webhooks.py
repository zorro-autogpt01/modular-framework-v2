import httpx

async def deliver(url: str, event: str, payload: dict):
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(url, json={"event": event, "payload": payload})
        except Exception:
            pass