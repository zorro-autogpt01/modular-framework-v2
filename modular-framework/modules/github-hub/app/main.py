from __future__ import annotations
import os
import asyncio
import uuid
import hmac
import hashlib
import json
import random
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel, Field
from loguru import logger
from pathlib import Path
import requests
import httpx

# Support both package and flat module imports
try:
    from .store import (
        list_connections, get_connection, upsert_connection,
        delete_connection, set_default, load_all, save_all,
        list_subscriptions, get_subscription, upsert_subscription,
        delete_subscription, record_delivery, update_seen_sha, get_seen_sha
    )
    from .github_api import GHClient
except ImportError:
    from store import (
        list_connections, get_connection, upsert_connection,
        delete_connection, set_default, load_all, save_all,
        list_subscriptions, get_subscription, upsert_subscription,
        delete_subscription, record_delivery, update_seen_sha, get_seen_sha
    )
    from github_api import GHClient

app = FastAPI(title="GitHub Hub", version="0.6.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

app.mount("/ui", StaticFiles(directory="public", html=True), name="ui")

# ===== Configuration from environment =====
GHH_POLL_INTERVAL_SEC = int(os.getenv("GHH_POLL_INTERVAL_SEC", "60"))
GHH_POLL_JITTER_FRACTION = float(os.getenv("GHH_POLL_JITTER_FRACTION", "0.2"))
GHH_POLL_CONCURRENCY = int(os.getenv("GHH_POLL_CONCURRENCY", "4"))
GHH_NOTIFY_TIMEOUT_MS = int(os.getenv("GHH_NOTIFY_TIMEOUT_MS", "5000"))
GHH_NOTIFY_RETRIES = int(os.getenv("GHH_NOTIFY_RETRIES", "3"))
GHH_NOTIFY_BACKOFF_BASE_SEC = float(os.getenv("GHH_NOTIFY_BACKOFF_BASE_SEC", "0.5"))
GHH_SIGNING_FALLBACK_SECRET = os.getenv("GHH_SIGNING_FALLBACK_SECRET")
GHH_ALLOW_HTTP_SUBSCRIBERS = os.getenv("GHH_ALLOW_HTTP_SUBSCRIBERS", "false").lower() == "true"
GHH_EMIT_ON_FIRST_SEEN = os.getenv("GHH_EMIT_ON_FIRST_SEEN", "false").lower() == "true"

# ===== Global state for polling/notifications =====
polling_task: Optional[asyncio.Task] = None
manual_poll_event = asyncio.Event()
notification_queue: asyncio.Queue = None
notification_workers: List[asyncio.Task] = []
shutdown_event = asyncio.Event()

# track last-checked time per connection (epoch seconds)
LAST_CHECKED: Dict[str, float] = {}

# ===== Startup/Shutdown =====
@app.on_event("startup")
async def startup_event():
    global polling_task, notification_queue, notification_workers

    notification_queue = asyncio.Queue(maxsize=1000)
    for _ in range(4):
        worker = asyncio.create_task(notification_worker())
        notification_workers.append(worker)

    polling_task = asyncio.create_task(polling_loop())
    logger.info("GitHub Hub polling and notification system started")

@app.on_event("shutdown")
async def shutdown_event_handler():
    global polling_task, notification_workers

    shutdown_event.set()

    if polling_task:
        polling_task.cancel()
        try:
            await polling_task
        except asyncio.CancelledError:
            pass

    try:
        await asyncio.wait_for(notification_queue.join(), timeout=10.0)
    except asyncio.TimeoutError:
        logger.warning("Notification queue did not drain in time")

    for worker in notification_workers:
        worker.cancel()
    await asyncio.gather(*notification_workers, return_exceptions=True)

    logger.info("GitHub Hub shutdown complete")

# ----- helpers -----

def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def _client_for_conn(conn: Dict[str, Any]) -> GHClient:
    tok = conn.get("token")
    if not tok:
        token_file = os.getenv("GITHUB_TOKEN_FILE")
        if token_file and Path(token_file).exists():
            tok = Path(token_file).read_text(encoding="utf-8").strip()
        tok = tok or os.getenv("GITHUB_TOKEN")
    if not tok:
        raise HTTPException(400, "No token available for this connection and no fallback provided.")
    base_url = conn.get("base_url") or os.getenv("GITHUB_API_BASE", "https://api.github.com")
    return GHClient(token=tok, base_url=base_url)

def _client_for_input(token: Optional[str], base_url: Optional[str]) -> GHClient:
    tok = token
    if not tok:
        token_file = os.getenv("GITHUB_TOKEN_FILE")
        if token_file and Path(token_file).exists():
            tok = Path(token_file).read_text(encoding="utf-8").strip()
        tok = tok or os.getenv("GITHUB_TOKEN")
    base = base_url or os.getenv("GITHUB_API_BASE", "https://api.github.com")
    return GHClient(token=tok or None, base_url=base)

def _owner_repo(conn: Dict[str, Any]) -> tuple[str, str]:
    url = conn.get("repo_url")
    if not url:
        raise HTTPException(400, "Connection has no repo_url.")
    try:
        return GHClient.parse_repo(url)
    except ValueError as e:
        raise HTTPException(400, str(e))

def _resolve_conn(conn_id: Optional[str], x_conn: Optional[str]) -> Dict[str, Any]:
    cid = conn_id or x_conn
    conn = get_connection(cid)
    if not conn:
        raise HTTPException(404, "Connection not found (or default unset).")
    return conn

def _default_branch_from(branches: List[str]) -> str:
    if not branches:
        return "main"
    if "main" in branches:
        return "main"
    if "master" in branches:
        return "master"
    return branches[0]

def _validate_connection_inputs(repo_url: str, base_url: Optional[str]) -> None:
    try:
        GHClient.parse_repo(repo_url)
    except ValueError as e:
        raise HTTPException(400, f"Invalid repo_url: {e}")
    if base_url:
        base_url = base_url.strip()
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            raise HTTPException(400, "base_url must start with http:// or https://")

def _map_github_error(e: Exception) -> HTTPException:
    if isinstance(e, requests.HTTPError) and e.response is not None:
        resp = e.response
        status = resp.status_code
        try:
            data = resp.json()
            gh_msg = data.get("message")
        except Exception:
            gh_msg = resp.text or ""
        if status == 403 and resp.headers.get("x-ratelimit-remaining") == "0":
            return HTTPException(429, "GitHub rate limit exceeded (unauthenticated). Add a PAT or wait and retry.")
        if status in (401,):
            return HTTPException(401, "GitHub rejected the request (unauthorized). Provide a valid PAT.")
        if status in (403,):
            return HTTPException(403, "Forbidden by GitHub: token lacks required scope or no access to repo.")
        if status in (404,):
            return HTTPException(404, "Repo not found or no access (private repo?).")
        return HTTPException(502, f"GitHub error {status}: {gh_msg or 'Unknown error'}")
    return HTTPException(400, f"Validation failed: {e}")

def _valid_https_url(u: str) -> bool:
    try:
        p = urlparse(u)
        return p.scheme in ("https",) and bool(p.netloc)
    except Exception:
        return False

# ===== Polling Implementation =====

async def polling_loop():
    """Background task that polls connections for changes."""
    while not shutdown_event.is_set():
        try:
            interval = GHH_POLL_INTERVAL_SEC
            jitter = interval * GHH_POLL_JITTER_FRACTION * random.random()
            sleep_time = interval + jitter

            try:
                await asyncio.wait_for(manual_poll_event.wait(), timeout=sleep_time)
                manual_poll_event.clear()
                logger.info("Manual poll triggered")
            except asyncio.TimeoutError:
                pass

            await check_all_connections()

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception(f"Error in polling loop: {e}")
            await asyncio.sleep(5)

async def check_all_connections():
    """Check all connections for changes (honors per-connection poll_interval_sec)."""
    conns = list_connections(redact=False)
    semaphore = asyncio.Semaphore(GHH_POLL_CONCURRENCY)
    now = datetime.now(timezone.utc).timestamp()
    tasks = []

    for conn in conns:
        conn_id = conn["id"]
        full = get_connection(conn_id)
        if not full:
            continue
        interval = int(full.get("poll_interval_sec") or GHH_POLL_INTERVAL_SEC)
        last = LAST_CHECKED.get(conn_id, 0)
        if (now - last) < interval:
            continue  # not due yet
        tasks.append(check_connection_with_limit(full, semaphore))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

async def check_connection_with_limit(conn: Dict[str, Any], semaphore: asyncio.Semaphore):
    async with semaphore:
        await check_connection(conn)

async def check_connection(conn: Dict[str, Any], specific_branch: Optional[str] = None):
    """Check a single connection for changes. If specific_branch set, only check that branch."""
    try:
        if not conn:
            return

        LAST_CHECKED[conn["id"]] = datetime.now(timezone.utc).timestamp()

        branches = [specific_branch] if specific_branch else (conn.get("watch_branches") or [])
        if not branches:
            branches = [conn.get("default_branch", "main")]

        client = _client_for_conn(conn)
        owner, repo = _owner_repo(conn)

        for branch in branches:
            await check_branch(conn, client, owner, repo, branch)

    except Exception as e:
        logger.exception(f"Error checking connection {conn.get('id')}: {e}")

async def check_branch(conn: Dict[str, Any], client: GHClient, owner: str, repo: str, branch: str):
    """Check a specific branch for changes."""
    try:
        current_sha = await asyncio.to_thread(client.get_branch_sha, owner, repo, branch)
        last_sha = get_seen_sha(conn["id"], branch)

        if last_sha is None:
            update_seen_sha(conn["id"], branch, current_sha)
            if GHH_EMIT_ON_FIRST_SEEN:
                await emit_change_event(conn, branch, None, current_sha, None)
            else:
                logger.info(f"First observation of {owner}/{repo}#{branch}: {current_sha[:7]}")
            return

        if current_sha != last_sha:
            logger.info(f"Change detected in {owner}/{repo}#{branch}: {last_sha[:7]} → {current_sha[:7]}")
            files = None
            try:
                compare = await asyncio.to_thread(client.compare_commits, owner, repo, last_sha, current_sha)
                files = [{"filename": f.get("filename"), "status": f.get("status")} for f in compare.get("files", [])]
            except Exception as e:
                logger.warning(f"Could not compare commits for {owner}/{repo}#{branch}: {e}")

            await emit_change_event(conn, branch, last_sha, current_sha, files)
            update_seen_sha(conn["id"], branch, current_sha)

    except Exception as e:
        logger.exception(f"Error checking branch {branch}: {e}")

async def emit_change_event(conn: Dict[str, Any], branch: str, old_sha: Optional[str],
                            new_sha: str, files: Optional[List[Dict[str, Any]]]):
    """Emit a change event to all matching subscribers."""
    event = build_repo_push_event(conn, branch, old_sha, new_sha, files)
    subscribers = list_subscriptions(redact=False)

    for sub in subscribers:
        if not sub.get("active", True):
            continue
        if sub.get("conn_id") and sub["conn_id"] != conn["id"]:
            continue
        if sub.get("branches") and branch not in sub["branches"]:
            continue
        if "repo.push" not in sub.get("events", ["repo.push"]):
            continue

        await notification_queue.put((sub, event))

def build_repo_push_event(conn: Dict[str, Any], branch: str, old_sha: Optional[str],
                          new_sha: str, files: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    owner, repo = GHClient.parse_repo(conn["repo_url"])
    base_url = conn.get("base_url", "https://api.github.com")

    compare_url = None
    if old_sha and "github.com" in (conn["repo_url"] or ""):
        compare_url = f"https://github.com/{owner}/{repo}/compare/{old_sha}...{new_sha}"

    event = {
        "type": "repo.push",
        "delivery_id": str(uuid.uuid4()),
        "repository": {
            "url": conn["repo_url"],
            "full_name": f"{owner}/{repo}",
            "owner": owner,
            "name": repo,
            "api_base": base_url
        },
        "connection": {
            "id": conn["id"],
            "default_branch": conn.get("default_branch", "main")
        },
        "branch": branch,
        "old_sha": old_sha,
        "new_sha": new_sha,
        "detected_at": _utcnow_iso(),
        "producer": "github-hub"
    }

    if compare_url:
        event["compare_url"] = compare_url
    if files is not None:
        event["files"] = files

    return event

def build_ping_event(sub: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "type": "ping",
        "delivery_id": str(uuid.uuid4()),
        "timestamp": _utcnow_iso(),
        "note": "test",
        "subscription_id": sub["id"],
        "producer": "github-hub"
    }

def compute_signature(secret: str, body_bytes: bytes) -> str:
    signature = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
    return f"sha256={signature}"

async def notification_worker():
    client = httpx.AsyncClient(timeout=httpx.Timeout(GHH_NOTIFY_TIMEOUT_MS / 1000.0))
    try:
        while not shutdown_event.is_set():
            try:
                sub, event = await asyncio.wait_for(notification_queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            try:
                await send_notification(client, sub, event)
            except Exception as e:
                logger.exception(f"Error in notification worker: {e}")
            finally:
                notification_queue.task_done()
    finally:
        await client.aclose()

async def send_notification(client: httpx.AsyncClient, sub: Dict[str, Any],
                            event: Dict[str, Any], retry_count: int = 0) -> bool:
    url = sub.get("url")
    if not url:
        logger.error(f"Subscriber {sub.get('id')} has no URL")
        return False
    if not GHH_ALLOW_HTTP_SUBSCRIBERS and not _valid_https_url(url):
        logger.error(f"Subscriber {sub.get('id')} has insecure/invalid URL: {url}")
        return False

    full_sub = get_subscription(sub["id"])
    if not full_sub:
        return False

    body_bytes = json.dumps(event, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-GHH-Event": event["type"],
        "X-GHH-Delivery": event["delivery_id"],
        "User-Agent": f"github-hub/{app.version}"
    }

    secret = (full_sub.get("secret") or GHH_SIGNING_FALLBACK_SECRET or "").strip()
    if secret:
        headers["X-GHH-Signature-256"] = compute_signature(secret, body_bytes)

    try:
        resp = await client.post(url, content=body_bytes, headers=headers)
        if 200 <= resp.status_code < 300:
            logger.info(f"Delivered {event['type']} to {sub['id']} ({resp.status_code})")
            record_delivery(sub["id"])
            return True

        logger.warning(f"Delivery error to {sub['id']}: HTTP {resp.status_code}")
        if resp.status_code >= 500 and retry_count < GHH_NOTIFY_RETRIES:
            backoff = GHH_NOTIFY_BACKOFF_BASE_SEC * (2 ** retry_count)
            await asyncio.sleep(backoff)
            return await send_notification(client, sub, event, retry_count + 1)
        return False

    except Exception as e:
        logger.warning(f"Delivery exception to {sub['id']}: {e}")
        if retry_count < GHH_NOTIFY_RETRIES:
            backoff = GHH_NOTIFY_BACKOFF_BASE_SEC * (2 ** retry_count)
            await asyncio.sleep(backoff)
            return await send_notification(client, sub, event, retry_count + 1)
        return False

# ----- models -----
class ConfigLegacyIn(BaseModel):
    repo_url: str
    default_branch: Optional[str] = "main"
    base_url: Optional[str] = "https://api.github.com"
    token: Optional[str] = None

class FilePut(BaseModel):
    path: str
    message: str
    content: str
    branch: Optional[str] = None
    sha: Optional[str] = None

class BatchChange(BaseModel):
    path: str
    content: str
    mode: Optional[str] = "100644"

class BatchCommit(BaseModel):
    branch: str
    message: str
    changes: List[BatchChange]

class PullRequestIn(BaseModel):
    title: str
    head: str
    base: str
    body: Optional[str] = None
    draft: Optional[bool] = False

class ConnectionIn(BaseModel):
    id: str
    repo_url: str
    default_branch: Optional[str] = None
    base_url: Optional[str] = "https://api.github.com"
    name: Optional[str] = None
    token: Optional[str] = None
    poll_interval_sec: Optional[int] = None
    watch_branches: Optional[List[str]] = None

class ConnectionTestIn(BaseModel):
    repo_url: str
    base_url: Optional[str] = "https://api.github.com"
    token: Optional[str] = None

class BranchCreateIn(BaseModel):
    new: str
    from_branch: Optional[str] = Field(default=None, alias="from")

class SubscriptionIn(BaseModel):
    id: Optional[str] = None
    url: str
    secret: Optional[str] = None
    events: Optional[List[str]] = ["repo.push"]
    conn_id: Optional[str] = None
    branches: Optional[List[str]] = None
    active: Optional[bool] = True

class SubscriptionUpdate(BaseModel):
    active: Optional[bool] = None

# ----- basic -----
@app.get("/")
def root():
    return RedirectResponse(url="/ui/")

@app.get("/.well-known/module.json")
def module_manifest_root():
    return JSONResponse({
        "id": "github",
        "name": "GitHub Hub",
        "version": app.version if hasattr(app, "version") else "0.6.0",
        "ui": "/ui/",
        "api_base": "/api",
        "health": "/api/health"
    })

@app.get("/api/.well-known/module.json")
def module_manifest_api():
    return module_manifest_root()

@app.get("/api/health")
def health():
    st = load_all()
    return {
        "status": "ok",
        "default_id": st.get("default_id"),
        "connections": [c["id"] for c in st.get("connections", [])],
        "subscriptions_count": len(st.get("subscriptions", [])),
        "polling": {
            "enabled": polling_task is not None and not polling_task.done(),
            "interval_sec": GHH_POLL_INTERVAL_SEC
        }
    }

# ===== Polling Control Endpoints =====

@app.post("/api/poll/run")
async def trigger_global_poll():
    manual_poll_event.set()
    return {"ok": True, "scheduled": True}

@app.post("/api/connections/{conn_id}/poll/run")
async def trigger_connection_poll(
    conn_id: str,
    branch: Optional[str] = Query(None),
):
    conn = get_connection(conn_id)
    if not conn:
        raise HTTPException(404, "Connection not found")
    # Bypass LAST_CHECKED guard
    asyncio.create_task(check_connection(conn, branch))
    return {"ok": True, "scheduled": True}

@app.get("/api/poll/status")
async def get_poll_status():
    conns = list_connections(redact=True)
    status = {
        "polling_enabled": polling_task is not None and not polling_task.done(),
        "interval_sec": GHH_POLL_INTERVAL_SEC,
        "connections": []
    }
    for conn in conns:
        status["connections"].append({
            "id": conn["id"],
            "repo_url": conn.get("repo_url"),
            "poll_interval_sec": conn.get("poll_interval_sec", GHH_POLL_INTERVAL_SEC),
            "watch_branches": conn.get("watch_branches", [conn.get("default_branch", "main")]),
            "seen": conn.get("seen", {})
        })
    return status

# ===== Subscription Endpoints =====

@app.post("/api/subscriptions")
async def create_subscription(body: SubscriptionIn):
    if not GHH_ALLOW_HTTP_SUBSCRIBERS and not _valid_https_url(body.url):
        raise HTTPException(400, "Only HTTPS URLs are allowed for subscriptions")
    valid_events = {"repo.push", "ping"}
    for event in body.events or ["repo.push"]:
        if event not in valid_events:
            raise HTTPException(400, f"Invalid event: {event}")

    data = body.model_dump(exclude_unset=True, exclude_none=True)
    sub = upsert_subscription(data)
    sub.pop("secret", None)
    sub.pop("secret_enc", None)
    sub.pop("secret_plain", None)
    if data.get("secret"):
        sub["secret"] = "[REDACTED]"
    return sub

@app.get("/api/subscriptions")
async def get_subscriptions():
    return {"subscriptions": list_subscriptions(redact=True)}

@app.get("/api/subscriptions/{sub_id}")
async def get_subscription_by_id(sub_id: str):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    sub.pop("secret", None)
    sub.pop("secret_enc", None)
    sub.pop("secret_plain", None)
    sub["secret"] = "[REDACTED]" if ("secret_enc" in sub or "secret_plain" in sub) else None
    return sub

@app.delete("/api/subscriptions/{sub_id}")
async def delete_subscription_endpoint(sub_id: str):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    delete_subscription(sub_id)
    return {"ok": True, "deleted": sub_id}

@app.post("/api/subscriptions/{sub_id}/test")
async def test_subscription(sub_id: str):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    event = build_ping_event(sub)
    client = httpx.AsyncClient(timeout=httpx.Timeout(GHH_NOTIFY_TIMEOUT_MS / 1000.0))
    try:
        ok = await send_notification(client, sub, event)
        return {"ok": ok, "delivery_id": event["delivery_id"], "status": "success" if ok else "failed"}
    finally:
        await client.aclose()

@app.post("/api/subscriptions/{sub_id}/pause")
async def pause_subscription(sub_id: str):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    updated = upsert_subscription({"id": sub_id, "active": False})
    updated.pop("secret", None)
    updated.pop("secret_enc", None)
    updated.pop("secret_plain", None)
    return {"ok": True, "active": False}

@app.post("/api/subscriptions/{sub_id}/resume")
async def resume_subscription(sub_id: str):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    updated = upsert_subscription({"id": sub_id, "active": True})
    updated.pop("secret", None)
    updated.pop("secret_enc", None)
    updated.pop("secret_plain", None)
    return {"ok": True, "active": True}

@app.patch("/api/subscriptions/{sub_id}")
async def update_subscription(sub_id: str, body: SubscriptionUpdate):
    sub = get_subscription(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    updates = body.model_dump(exclude_unset=True)
    if updates:
        updates["id"] = sub_id
        sub = upsert_subscription(updates)
    sub.pop("secret", None)
    sub.pop("secret_enc", None)
    sub.pop("secret_plain", None)
    return sub

# ----- connection management -----
@app.get("/api/connections")
def api_list_conns():
    st = load_all()
    return {"default_id": st.get("default_id"), "connections": list_connections(redact=True)}

@app.post("/api/connections/validate")
def api_validate_conn(body: ConnectionTestIn):
    _validate_connection_inputs(body.repo_url, body.base_url)
    client = _client_for_input(body.token, body.base_url)
    try:
        owner, repo = GHClient.parse_repo(body.repo_url)
        branches = client.get_branches(owner, repo)
        return {"ok": True, "branches": branches, "default_branch": _default_branch_from(branches)}
    except Exception as e:
        logger.exception("Connection validation failed")
        raise _map_github_error(e)

@app.post("/api/connections")
def api_upsert_conn(body: ConnectionIn):
    _validate_connection_inputs(body.repo_url, body.base_url)
    try:
        client = _client_for_input(body.token, body.base_url)
        owner, repo = GHClient.parse_repo(body.repo_url)
        branches = client.get_branches(owner, repo)
    except Exception as e:
        logger.exception("connection validation failed")
        raise _map_github_error(e)

    try:
        upsert_payload = body.model_dump(exclude_unset=True)
        if not upsert_payload.get("default_branch"):
            upsert_payload["default_branch"] = _default_branch_from(branches)
        c = upsert_connection(upsert_payload)
        st = load_all()
        for cc in st["connections"]:
            if cc["id"] == c["id"]:
                cc["branches"] = branches
        save_all(st)
        return {"ok": True, "id": c["id"], "branches": branches, "default_branch": upsert_payload["default_branch"]}
    except Exception as e:
        logger.exception("failed to save connection")
        raise HTTPException(500, f"Failed to save connection: {e}")

@app.delete("/api/connections/{conn_id}")
def api_delete_conn(conn_id: str):
    delete_connection(conn_id)
    return {"ok": True}

@app.post("/api/connections/{conn_id}/default")
def api_set_default(conn_id: str):
    set_default(conn_id)
    return {"ok": True, "default_id": conn_id}

@app.put("/api/connections/{conn_id}/default")
def api_set_default_put(conn_id: str):
    return api_set_default(conn_id)

@app.get("/api/connections/{conn_id}/health")
def api_conn_health(conn_id: str):
    conn = _resolve_conn(conn_id, None)
    gh = _client_for_conn(conn)
    owner, repo = _owner_repo(conn)
    try:
        branches = gh.get_branches(owner, repo)
        st = load_all()
        for cc in st.get("connections", []):
            if cc.get("id") == conn_id:
                cc["branches"] = branches
        save_all(st)
        return {"ok": True, "branches": branches}
    except Exception as e:
        raise _map_github_error(e)

# ----- legacy "config" view -----
@app.get("/api/config")
def get_cfg():
    st = load_all()
    default_id = st.get("default_id")
    conns = list_connections(redact=True)
    default_conn = next((c for c in conns if c.get("id") == default_id), conns[0] if conns else None)
    return {
        "default_id": default_id,
        "connections": conns,
        "repo_url": (default_conn or {}).get("repo_url"),
        "base_url": (default_conn or {}).get("base_url") or "https://api.github.com",
    }

@app.post("/api/config")
def legacy_set_cfg(body: ConfigLegacyIn):
    _validate_connection_inputs(body.repo_url, body.base_url)
    client = _client_for_input(body.token, body.base_url)
    owner, repo = GHClient.parse_repo(body.repo_url)
    branches = client.get_branches(owner, repo)

    data = {
        "id": "default",
        "repo_url": body.repo_url,
        "default_branch": body.default_branch or _default_branch_from(branches),
        "base_url": body.base_url,
    }
    if body.token:
        data["token"] = body.token
    upsert_connection(data)
    set_default("default")
    st = load_all()
    for cc in st["connections"]:
        if cc["id"] == "default":
            cc["branches"] = branches
    save_all(st)
    return {"ok": True, "branches": branches, "default_id": "default"}

# ----- GitHub operations (conn-aware) -----
@app.get("/api/branches")
def branches(
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn)
    owner, repo = _owner_repo(conn)
    return {"branches": gh.get_branches(owner, repo)}

@app.post("/api/branch")
def create_branch(
    body: Optional[BranchCreateIn] = None,
    new_q: Optional[str] = Query(None, alias="new"),
    from_q: Optional[str] = Query(None, alias="from"),
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    new = (body.new if body and body.new else new_q)
    base = (body.from_branch if body and body.from_branch else from_q)
    if not new or not base:
        raise HTTPException(400, "Both 'new' and 'from' are required (query or JSON body).")

    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn)
    owner, repo = _owner_repo(conn)

    try:
        return gh.create_branch(owner, repo, new, base)
    except Exception as e:
        raise _map_github_error(e)

@app.get("/api/tree")
def tree(
    path: Optional[str] = None,
    branch: Optional[str] = None,
    recursive: bool = True,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    b = branch or conn.get("default_branch") or "main"
    t = gh.get_tree(owner, repo, b, recursive=bool(recursive))
    items = t.get("tree", [])
    if path:
        prefix = path.strip().rstrip("/") + "/"
        items = [i for i in items if i["path"].startswith(prefix)]
    return {"branch": b, "items": items}

@app.get("/api/file")
def get_file(
    path: str,
    branch: Optional[str] = None,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    ref = branch or conn.get("default_branch") or "main"
    return gh.get_file(owner, repo, path, ref=ref)

@app.put("/api/file")
def put_file(
    body: FilePut,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    b = body.branch or conn.get("default_branch") or "main"
    return gh.put_file(owner, repo, body.path, body.message, body.content, b, body.sha)

@app.delete("/api/file")
def delete_file(
    path: str, message: str, sha: str, branch: Optional[str] = None,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    b = branch or conn.get("default_branch") or "main"
    return gh.delete_file(owner, repo, path, message, sha, b)

@app.post("/api/batch/commit")
def batch_commit(
    body: BatchCommit,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    changes = [c.model_dump() for c in body.changes]
    return gh.batch_commit(owner, repo, body.branch, body.message, changes)

@app.post("/api/pr")
def create_pr(
    body: PullRequestIn,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    try:
        pr = gh.create_pull_request(owner, repo, body.title, body.head, body.base, body.body, body.draft or False)
        return {"ok": True, "pull_request": pr}
    except Exception as e:
        logger.exception("Failed to create PR")
        raise HTTPException(400, f"PR creation failed: {e}")

@app.get("/api/compare")
def compare(
    base: str, head: str,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    return gh.compare_commits(owner, repo, base, head)

@app.get("/api/commits")
def list_commits(
    sha: Optional[str] = None, path: Optional[str] = None, per_page: int = 100,
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    return gh.list_commits(owner, repo, sha=sha, path=path, per_page=per_page)

@app.get("/api/connections/{conn_id}")
def api_get_connection(conn_id: str):
    c = get_connection(conn_id)
    if not c:
        raise HTTPException(404, "Connection not found")
    c.pop("token", None)
    c.pop("token_enc", None)
    c.pop("token_plain", None)
    return c

@app.head("/api/connections/{conn_id}")
def api_head_connection(conn_id: str):
    c = get_connection(conn_id)
    if not c:
        raise HTTPException(404, "Connection not found")
    return {"ok": True}

@app.get("/api/connections/{conn_id}/clone_url")
def api_get_clone_url(conn_id: str):
    conn = _resolve_conn(conn_id, None)
    repo_url = conn.get("repo_url")
    github_token = conn.get("token")
    if not repo_url:
        raise HTTPException(400, "Connection has no repo_url configured.")
    if not github_token:
        raise HTTPException(400, "Authentication token is required but not available for this connection.")
    if repo_url.startswith("https://"):
        authenticated_repo_url = repo_url.replace("https://", f"https://{github_token}@")
    elif repo_url.startswith("http://"):
        authenticated_repo_url = repo_url.replace("http://", f"http://{github_token}@")
    else:
        raise HTTPException(400, "Only HTTPS/HTTP repo_urls can be used for authenticated cloning via this endpoint.")
    return {"clone_url": authenticated_repo_url}