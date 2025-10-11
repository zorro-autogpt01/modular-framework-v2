from __future__ import annotations
import os
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel, Field
from loguru import logger
from pathlib import Path
import requests

# Support both package and flat module imports
try:
    from .store import (
        list_connections, get_connection, upsert_connection,
        delete_connection, set_default, load_all, save_all
    )
    from .github_api import GHClient
except ImportError:
    from store import (
        list_connections, get_connection, upsert_connection,
        delete_connection, set_default, load_all, save_all
    )
    from github_api import GHClient

app = FastAPI(title="GitHub Hub", version="0.4.2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

app.mount("/ui", StaticFiles(directory="public", html=True), name="ui")

# ----- helpers -----

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
    # Relaxed: allow missing token (unauthenticated validation for public repos)
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
        # Rate limit
        if status == 403 and resp.headers.get("x-ratelimit-remaining") == "0":
            return HTTPException(429, "GitHub rate limit exceeded (unauthenticated). Add a PAT or wait and retry.")
        if status in (401,):
            return HTTPException(401, "GitHub rejected the request (unauthorized). Provide a valid PAT.")
        if status in (403,):
            return HTTPException(403, "Forbidden by GitHub: token lacks required scope or no access to repo.")
        if status in (404,):
            return HTTPException(404, "Repo not found or no access (private repo?).")
        return HTTPException(502, f"GitHub error {status}: {gh_msg or 'Unknown error'}")
    # Fallback
    return HTTPException(400, f"Validation failed: {e}")

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

class ConnectionTestIn(BaseModel):
    repo_url: str
    base_url: Optional[str] = "https://api.github.com"
    token: Optional[str] = None

class BranchCreateIn(BaseModel):
    new: str
    from_branch: Optional[str] = Field(default=None, alias="from")

# ----- basic -----
@app.get("/")
def root():
    return RedirectResponse(url="/ui/")

@app.get("/.well-known/module.json")
def module_manifest_root():
    return JSONResponse({
        "id": "github",
        "name": "GitHub Hub",
        "version": app.version if hasattr(app, "version") else "0.4.2",
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
    return {"status": "ok", "default_id": st.get("default_id"), "connections": [c["id"] for c in st.get("connections", [])]}

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

# ----- legacy “config” view (now shows multi-conn) -----
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
    # allow either query or JSON body; JSON wins if provided
    body: Optional[BranchCreateIn] = None,
    new_q: Optional[str] = Query(None, alias="new"),
    from_q: Optional[str] = Query(None, alias="from"),
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    # resolve inputs
    new = (body.new if body and body.new else new_q)
    base = (body.from_branch if body and body.from_branch else from_q)
    if not new or not base:
        raise HTTPException(400, "Both 'new' and 'from' are required (query or JSON body).")

    # resolve connection
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn)
    owner, repo = _owner_repo(conn)

    try:
        return gh.create_branch(owner, repo, new, base)
    except Exception as e:
        # turn GitHub errors into proper 4xx/5xx
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
    # redact secrets before returning
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
