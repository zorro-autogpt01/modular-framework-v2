from __future__ import annotations
import os
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from loguru import logger
from pathlib import Path

from .store import (
    list_connections, get_connection, upsert_connection,
    delete_connection, set_default, load_all, save_all
)
from .github_api import GHClient

app = FastAPI(title="GitHub Hub", version="0.3.0")

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

def _owner_repo(conn: Dict[str, Any]) -> tuple[str, str]:
    url = conn.get("repo_url")
    if not url:
        raise HTTPException(400, "Connection has no repo_url.")
    return GHClient.parse_repo(url)

def _resolve_conn(conn_id: Optional[str], x_conn: Optional[str]) -> Dict[str, Any]:
    cid = conn_id or x_conn
    conn = get_connection(cid)
    if not conn:
        raise HTTPException(404, "Connection not found (or default unset).")
    return conn

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
    default_branch: Optional[str] = "main"
    base_url: Optional[str] = "https://api.github.com"
    name: Optional[str] = None
    token: Optional[str] = None

# ----- basic -----
@app.get("/")
def root():
    return RedirectResponse(url="/ui/")

@app.get("/api/health")
def health():
    st = load_all()
    return {"status": "ok", "default_id": st.get("default_id"), "connections": [c["id"] for c in st.get("connections", [])]}

# ----- connection management -----
@app.get("/api/connections")
def api_list_conns():
    st = load_all()
    return {"default_id": st.get("default_id"), "connections": list_connections(redact=True)}

@app.post("/api/connections")
def api_upsert_conn(body: ConnectionIn):
    try:
        c = upsert_connection(body.model_dump(exclude_unset=True))
        gh = _client_for_conn(c)
        owner, repo = _owner_repo(c)
        branches = gh.get_branches(owner, repo)
        # persist branches back
        st = load_all()
        for cc in st["connections"]:
            if cc["id"] == c["id"]:
                cc["branches"] = branches
                if body.default_branch:
                    cc["default_branch"] = body.default_branch
        save_all(st)
        return {"ok": True, "id": c["id"], "branches": branches}
    except Exception as e:
        logger.exception("connection upsert/validate failed")
        raise HTTPException(400, f"Connection saved but validation failed: {e}")

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
        return {"ok": True, "branches": branches}
    except Exception as e:
        raise HTTPException(502, f"GitHub failed: {e}")

# ----- legacy “config” view (now shows multi-conn) -----
@app.get("/api/config")
def get_cfg():
    st = load_all()
    return {"default_id": st.get("default_id"), "connections": list_connections(redact=True)}

@app.post("/api/config")
def legacy_set_cfg(body: ConfigLegacyIn):
    # Upsert a “default” connection and set it default
    data = {
        "id": "default",
        "repo_url": body.repo_url,
        "default_branch": body.default_branch,
        "base_url": body.base_url,
    }
    if body.token:
        data["token"] = body.token
    c = upsert_connection(data)
    set_default("default")
    # Validate + persist branches
    gh = _client_for_conn(c); owner, repo = _owner_repo(c)
    branches = gh.get_branches(owner, repo)
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
    new: str = Query(..., alias="new"),
    base: str = Query(..., alias="from"),
    conn_id: Optional[str] = Query(None),
    x_conn: Optional[str] = Header(None, alias="X-GH-Conn"),
):
    conn = _resolve_conn(conn_id, x_conn)
    gh = _client_for_conn(conn); owner, repo = _owner_repo(conn)
    return gh.create_branch(owner, repo, new, base)

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

# ---- Nice-to-have “git basics” via GitHub API ----
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