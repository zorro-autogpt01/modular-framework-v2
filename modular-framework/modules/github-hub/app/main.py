from __future__ import annotations
import os
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from loguru import logger
from pathlib import Path

from .store import load_config, save_config
from .github_api import GHClient

app = FastAPI(title="GitHub Hub", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# serve the tiny UI
# Serve UI at /ui to avoid shadowing /api/*
app.mount("/ui", StaticFiles(directory="public", html=True), name="ui")

def _read_token() -> Optional[str]:
    """Read token from env or Docker secret file."""
    token_file = os.getenv("GITHUB_TOKEN_FILE")
    if token_file and Path(token_file).exists():
        return Path(token_file).read_text(encoding="utf-8").strip()
    return os.getenv("GITHUB_TOKEN")

def _client_from_cfg(cfg: Dict[str, Any]) -> GHClient:
    token = _read_token()
    if not token:
        raise HTTPException(400, "GITHUB_TOKEN not set (or GITHUB_TOKEN_FILE missing).")
    base_url = cfg.get("base_url") or os.getenv("GITHUB_API_BASE", "https://api.github.com")
    return GHClient(token=token, base_url=base_url)


@app.get("/")
def root():
    # convenience: / -> /ui/
    return RedirectResponse(url="/ui/")
def _client_from_cfg(cfg: Dict[str, Any]) -> GHClient:
    token = _read_token()
    if not token:
        raise HTTPException(400, "GITHUB_TOKEN not set (or GITHUB_TOKEN_FILE missing).")
    base_url = cfg.get("base_url") or os.getenv("GITHUB_API_BASE", "https://api.github.com")
    return GHClient(token=token, base_url=base_url)

def _owner_repo_from_cfg(cfg: Dict[str, Any]) -> tuple[str, str]:
    url = cfg.get("repo_url")
    if not url:
        raise HTTPException(400, "No repo_url in config.")
    return GHClient.parse_repo(url)

# --------- models ----------
class ConfigIn(BaseModel):
    repo_url: str = Field(..., examples=["https://github.com/owner/repo"])
    default_branch: Optional[str] = "main"
    token: Optional[str] = None
    base_url: Optional[str] = "https://api.github.com"  # for GH Enterprise

class FilePut(BaseModel):
    path: str
    message: str
    content: str
    branch: Optional[str] = None
    sha: Optional[str] = None  # include for updates

class BatchChange(BaseModel):
    path: str
    content: str
    mode: Optional[str] = "100644"

class BatchCommit(BaseModel):
    branch: str
    message: str
    changes: List[BatchChange]

# --------- API ----------
@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/config")
def get_cfg():
    cfg = load_config()
    # never return token/plain/enc to UI
    cfg.pop("token", None)
    cfg.pop("token_plain", None)
    cfg.pop("token_enc", None)
    return cfg

@app.post("/api/config")
def set_cfg(body: ConfigIn):
    cfg = load_config()
    cfg.update(body.model_dump(exclude_unset=True))
    out = save_config(cfg)
    try:
        # test connectivity + preload branches
        gh = _client_from_cfg(out)
        owner, repo = _owner_repo_from_cfg(out)
        branches = gh.get_branches(owner, repo)
        out["branches"] = branches
        out = save_config(out)
        return {"ok": True, "branches": branches}
    except Exception as e:
        logger.exception("Config check failed")
        raise HTTPException(400, f"Saved config but GitHub check failed: {e}")

@app.get("/api/branches")
def branches():
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    return {"branches": gh.get_branches(owner, repo)}

@app.post("/api/branch")
def create_branch(new: str = Query(..., alias="new"), base: str = Query(..., alias="from")):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    return gh.create_branch(owner, repo, new, base)

@app.get("/api/tree")
def tree(path: Optional[str] = None, branch: Optional[str] = None, recursive: bool = True):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    b = branch or cfg.get("default_branch") or "main"
    t = gh.get_tree(owner, repo, b, recursive=True if recursive else False)
    items = t.get("tree", [])
    if path:
        prefix = path.strip().rstrip("/") + "/"
        items = [i for i in items if i["path"].startswith(prefix)]
    return {"branch": b, "items": items}

@app.get("/api/file")
def get_file(path: str, branch: Optional[str] = None):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    ref = branch or cfg.get("default_branch") or "main"
    return gh.get_file(owner, repo, path, ref=ref)

@app.put("/api/file")
def put_file(body: FilePut):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    b = body.branch or cfg.get("default_branch") or "main"
    return gh.put_file(owner, repo, body.path, body.message, body.content, b, body.sha)

@app.delete("/api/file")
def delete_file(path: str, message: str, sha: str, branch: Optional[str] = None):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    b = branch or cfg.get("default_branch") or "main"
    return gh.delete_file(owner, repo, path, message, sha, b)

@app.post("/api/batch/commit")
def batch_commit(body: BatchCommit):
    cfg = load_config()
    gh = _client_from_cfg(cfg)
    owner, repo = _owner_repo_from_cfg(cfg)
    changes = [c.model_dump() for c in body.changes]
    return gh.batch_commit(owner, repo, body.branch, body.message, changes)
