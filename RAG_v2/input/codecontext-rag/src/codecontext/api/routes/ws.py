from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio

router = APIRouter(prefix="/ws", tags=["WebSockets"])

@router.websocket("/repositories/{repo_id}/index")
async def ws_index_progress(websocket: WebSocket, repo_id: str):
    await websocket.accept()
    try:
        # Initial send
        await _send_status(websocket, repo_id)
        # Poll job store every second and send updates
        while True:
            await asyncio.sleep(1.0)
            cont = await _send_status(websocket, repo_id)
            if not cont:
                break
    except WebSocketDisconnect:
        return
    except Exception:
        # best-effort close
        try:
            await websocket.close()
        except Exception:
            pass


async def _send_status(websocket: WebSocket, repo_id: str) -> bool:
    app = websocket.app
    job_store = app.state.job_store
    repo_store = app.state.repo_store

    status_data = job_store.status_for_repo(repo_id)
    if not status_data:
        # No active job -> reflect repo status
        repo = repo_store.get(repo_id)
        st = (repo or {}).get("status", "unknown")
        payload = {
            "repo_id": repo_id,
            "status": st,
            "progress": {"current": 0, "total": 100, "percentage": 0.0}
        }
        await websocket.send_json(payload)
        # If not indexing/running, stop
        return st in ("indexing", "running")

    # Normalize fields and send
    payload = {
        "repo_id": repo_id,
        "status": status_data.get("status", "unknown"),
        "progress": status_data.get("progress") or {"current": 0, "total": 100, "percentage": 0.0},
        "started_at": status_data.get("started_at"),
        "completed_at": status_data.get("completed_at"),
        "error": status_data.get("error"),
    }
    await websocket.send_json(payload)

    # Stop when completed/failed
    if payload["status"] in ("completed", "failed", "error"):
        return False
    return True