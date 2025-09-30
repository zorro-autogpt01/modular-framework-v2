
import os
import json
import asyncio
import hashlib
import base64
import tarfile
import difflib
import fnmatch
import re
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timedelta

import aiohttp
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from loguru import logger
import yaml

from engine.github_hub import fetch_repo_tree, fetch_file_content
from engine.extractor import CodeExtractor
from engine.normalizer import ChunkNormalizer
from engine.generator import DocGenerator
from engine.verifier import DocVerifier



# -----------------------------------------------------------------------------
# App and config
# -----------------------------------------------------------------------------

logger.add("logs/llm-documentor.log", rotation="10 MB")

app = FastAPI(title="LLM Documentor", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

GITHUB_HUB_URL = os.getenv("GITHUB_HUB_URL", "http://github-hub-module:3005/api").rstrip("/")
LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:3010/api").rstrip("/")
GITHUB_API_BASE = os.getenv("GITHUB_API_BASE", "https://api.github.com").rstrip("/")

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
OUTPUT_DIR = DATA_DIR / "output"
CACHE_DIR = DATA_DIR / "cache"
TEMPLATES_DATA_DIR = DATA_DIR / "templates"
TEMPLATES_APP_DIR = Path("/app/templates")
SCHEDULES_PATH = DATA_DIR / "schedules.json"

for d in (DATA_DIR, OUTPUT_DIR, CACHE_DIR, TEMPLATES_DATA_DIR):
    d.mkdir(parents=True, exist_ok=True)

# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------

class DocPack(BaseModel):
    name: str
    description: str
    audience: str
    template: str
    output_path: str

class DocRequest(BaseModel):
    # Repo selection
    repo_url: Optional[str] = Field(default=None, description="Override repo URL; if None, use github-hub configured repo")
    branch: str = Field(default="main", description="Branch to document")

    # Packs
    packs: List[str] = Field(default=["high-level", "api", "detailed"], description="Doc packs to generate")

    # Model selection (via LLM Gateway)
    model_key: Optional[str] = Field(default=None, description="Gateway model key (e.g. openai:gpt-4o-mini)")
    model_id: Optional[int] = Field(default=None, description="Gateway model id")
    model_name: Optional[str] = Field(default=None, description="Gateway upstream model name (e.g. gpt-4o-mini)")
    model: Optional[str] = Field(default=None, description="Deprecated alias for model_key")

    # Caching
    force_refresh: bool = Field(default=False, description="Ignore extraction cache")

    # Scope controls
    include_globs: Optional[List[str]] = Field(default_factory=list, description="Include-only glob patterns")
    exclude_globs: Optional[List[str]] = Field(default_factory=list, description="Exclude glob patterns")
    modules: Optional[List[str]] = Field(default_factory=list, description="Subset of modules (folder names under modules/)")
    file_types: Optional[List[str]] = Field(default_factory=list, description="Allowed file extensions (py, js, ts, sql, ...)")
    incremental: Optional[bool] = Field(default=False, description="If true, generate only for changed components since last run")

    # Advanced model options
    temperature: Optional[float] = Field(default=0.3)
    max_tokens: Optional[int] = Field(default=4000)
    reasoning: Optional[bool] = Field(default=False)
    prompt_limit: Optional[int] = Field(default=8000)

    # Template/prompt customizations
    pack_prompts: Optional[Dict[str, str]] = Field(default_factory=dict, description="Extra prompt text per pack")
    per_pack_templates: Optional[Dict[str, str]] = Field(default_factory=dict, description="Template filename override per pack")

class DocJob(BaseModel):
    id: str
    status: str  # pending, extracting, generating, verifying, complete, failed
    progress: int  # 0-100
    message: str
    repo_url: Optional[str]
    branch: str
    packs: List[str]
    started_at: datetime
    completed_at: Optional[datetime] = None
    output_path: Optional[str] = None
    error: Optional[str] = None

# -----------------------------------------------------------------------------
# State and packs
# -----------------------------------------------------------------------------

jobs: Dict[str, DocJob] = {}

DOC_PACKS = {
    "super-detailed": DocPack(
        name="super-detailed",
        description="Per-module deep technical documentation",
        audience="engineers",
        template="super_detailed.md",
        output_path="components/{module}.md",
    ),
    "detailed": DocPack(
        name="detailed",
        description="Component-level documentation",
        audience="development team",
        template="detailed.md",
        output_path="components/{service}.md",
    ),
    "high-level": DocPack(
        name="high-level",
        description="System overview and architecture",
        audience="stakeholders",
        template="high_level.md",
        output_path="overview/SYSTEM_OVERVIEW.md",
    ),
    "api": DocPack(
        name="api",
        description="API reference documentation",
        audience="developers",
        template="api_reference.md",
        output_path="api/{endpoint_group}.md",
    ),
    "db": DocPack(
        name="db",
        description="Database schema documentation",
        audience="engineers",
        template="db_schema.md",
        output_path="db/SCHEMA.md",
    ),
    "ops": DocPack(
        name="ops",
        description="Operations and deployment guides",
        audience="devops",
        template="operations.md",
        output_path="ops/{topic}.md",
    ),
    "cookbook": DocPack(
        name="cookbook",
        description="How-to guides and recipes",
        audience="developers",
        template="cookbook.md",
        output_path="guides/COOKBOOK.md",
    ),
}

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _read_github_token() -> Optional[str]:
    token_file = os.getenv("GITHUB_TOKEN_FILE")
    if token_file and Path(token_file).exists():
        try:
            t = Path(token_file).read_text(encoding="utf-8").strip()
            if t:
                return t
        except Exception:
            pass
    t = os.getenv("GITHUB_TOKEN")
    return t.strip() if t else None

def parse_repo(url: str) -> Tuple[str, str]:
    parts = url.strip().rstrip("/").split("/")
    if len(parts) < 2:
        raise ValueError("Invalid repo URL")
    owner, repo = parts[-2], parts[-1].removesuffix(".git")
    return owner, repo

async def gh_direct_get_branch_sha(session: aiohttp.ClientSession, owner: str, repo: str, branch: str, token: Optional[str]) -> str:
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/branches/{branch}"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with session.get(url, headers=headers, timeout=30) as resp:
        if resp.status != 200:
            raise HTTPException(status_code=resp.status, detail=f"GitHub branch lookup failed: {await resp.text()}")
        data = await resp.json()
        return data.get("commit", {}).get("sha", "")

async def gh_direct_get_tree(session: aiohttp.ClientSession, owner: str, repo: str, branch: str, token: Optional[str]) -> Dict[str, Any]:
    sha = await gh_direct_get_branch_sha(session, owner, repo, branch, token)
    if not sha:
        raise HTTPException(400, "Could not resolve branch SHA")
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/git/trees/{sha}?recursive=1"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with session.get(url, headers=headers, timeout=60) as resp:
        if resp.status != 200:
            raise HTTPException(status_code=resp.status, detail=f"GitHub tree fetch failed: {await resp.text()}")
        data = await resp.json()
        items = data.get("tree", [])
        return {"branch": branch, "items": items}

async def gh_direct_get_file(session: aiohttp.ClientSession, owner: str, repo: str, path: str, ref: str, token: Optional[str]) -> str:
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/contents/{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    params = {"ref": ref} if ref else None
    async with session.get(url, headers=headers, params=params, timeout=45) as resp:
        if resp.status != 200:
            return ""
        data = await resp.json()
        content_b64 = data.get("content") or ""
        if not content_b64:
            return ""
        try:
            return base64.b64decode(content_b64.encode("utf-8")).decode("utf-8", errors="ignore")
        except Exception:
            return ""

async def gh_hub_get_json(path: str, params: Optional[Dict[str, Any]] = None, timeout: int = 60) -> Any:
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{GITHUB_HUB_URL}{path}", params=params, timeout=timeout) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail=f"github-hub GET {path} failed: {await resp.text()}")
            return await resp.json()

async def gh_hub_post_json(path: str, payload: Any, timeout: int = 60) -> Any:
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{GITHUB_HUB_URL}{path}", json=payload, timeout=timeout) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail=f"github-hub POST {path} failed: {await resp.text()}")
            return await resp.json()



# -----------------------------------------------------------------------------
# Schedules (simple in-process scheduler)
# -----------------------------------------------------------------------------

_schedules: List[Dict[str, Any]] = []
_scheduler_task: Optional[asyncio.Task] = None

def read_schedules() -> List[Dict[str, Any]]:
    if not SCHEDULES_PATH.exists():
        return []
    try:
        return json.loads(SCHEDULES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []

def write_schedules(items: List[Dict[str, Any]]):
    SCHEDULES_PATH.write_text(json.dumps(items or [], indent=2), encoding="utf-8")

async def scheduler_loop():
    last_run: Dict[str, datetime] = {}
    while True:
        try:
            items = list(_schedules)
            now = datetime.utcnow()
            for it in items:
                sid = it.get("id") or "default"
                every = max(0, int(it.get("every_seconds") or 0))
                if every <= 0:
                    continue
                prev = last_run.get(sid, datetime.fromtimestamp(0))
                if (now - prev).total_seconds() >= every:
                    last_run[sid] = now
                    # trigger generation
                    try:
                        req = DocRequest(
                            repo_url=None if it.get("use_hub", True) else it.get("repo_url"),
                            branch=it.get("branch") or "main",
                            packs=it.get("packs") or ["high-level", "detailed"],
                        )
                        model_ref = {"model_key": it.get("model_key"), "model_id": it.get("model_id"), "model_name": it.get("model_name")}
                        await create_job_and_process(req, model_ref)
                        logger.info(f"Schedule {sid} triggered docs generation")
                    except Exception as e:
                        logger.error(f"Schedule {sid} run failed: {e}")
        except Exception as e:
            logger.error(f"Scheduler loop error: {e}")
        await asyncio.sleep(2)

@app.on_event("startup")
async def on_startup():
    global _schedules, _scheduler_task
    _schedules = read_schedules()
    if _scheduler_task is None:
        _scheduler_task = asyncio.create_task(scheduler_loop())

# -----------------------------------------------------------------------------
# API: helpers and core endpoints
# -----------------------------------------------------------------------------

@app.get("/")
async def root():
    return FileResponse("/app/public/index.html")

@app.get("/api/health")
async def health():
    return {"status": "healthy", "service": "llm-documentor"}

@app.get("/api/packs")
async def list_packs():
    return {
        "packs": [
            {"name": pack.name, "description": pack.description, "audience": pack.audience}
            for pack in DOC_PACKS.values()
        ]
    }

@app.get("/api/default-repo")
async def get_default_repo():
    cfg = await gh_hub_get_json("/config", params=None, timeout=20)
    branches = []
    try:
        b = await gh_hub_get_json("/branches", params=None, timeout=30)
        branches = list(b.get("branches", []) or [])
    except Exception:
        pass
    return {
        "repo_url": cfg.get("repo_url"),
        "default_branch": cfg.get("default_branch") or "main",
        "branches": branches,
    }

@app.get("/api/models")
async def list_models():
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{LLM_GATEWAY_URL}/models", timeout=20) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail=f"gateway models failed: {await resp.text()}")
            data = await resp.json()
    items = data.get("items", []) or []
    out = []
    for m in items:
        out.append({
            "id": m.get("id"),
            "key": m.get("key"),
            "model_name": m.get("model_name"),
            "display_name": m.get("display_name") or m.get("model_name"),
            "provider_id": m.get("provider_id"),
            "provider_kind": m.get("provider_kind") or "",
            "mode": m.get("mode") or "auto",
            "supports_responses": bool(m.get("supports_responses")),
            "supports_reasoning": bool(m.get("supports_reasoning")),
        })
    return {"items": out}

@app.post("/api/generate")
async def generate_docs(request: DocRequest, background_tasks: BackgroundTasks):
    model_key = request.model_key or request.model
    model_ref = {
        "model_key": model_key,
        "model_id": request.model_id,
        "model_name": request.model_name,
    }
    job_id = await create_job(request, model_ref)
    background_tasks.add_task(process_doc_job, job_id, request, model_ref)
    return {"job_id": job_id, "status": "started"}

@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@app.get("/api/jobs")
async def list_jobs_api():
    return {"jobs": list(jobs.values())}

@app.get("/api/output/{job_id}")
async def get_job_output(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "complete":
        raise HTTPException(status_code=400, detail="Job not complete")
    if not job.output_path:
        raise HTTPException(status_code=404, detail="No output available")
    return FileResponse(job.output_path, filename=f"docs_{job_id}.tar.gz")

@app.get("/api/output/{job_id}/files")
async def list_output_files(job_id: str):
    base = OUTPUT_DIR / job_id
    if not base.exists():
        raise HTTPException(404, "No output directory for job")
    files: List[str] = []
    for p in base.rglob("*"):
        if p.is_file():
            rel = p.relative_to(base).as_posix()
            files.append(rel)
    files.sort()
    return {"files": files}

@app.get("/api/output/{job_id}/file")
async def get_output_file(job_id: str, path: str = Query(..., description="Relative path inside job output dir")):
    base = OUTPUT_DIR / job_id
    target = (base / path).resolve()
    if not str(target).startswith(str(base.resolve())):
        raise HTTPException(400, "Invalid path")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "Not found")
    try:
        text = target.read_text(encoding="utf-8")
    except Exception:
        text = ""
    return {"content": text}

@app.get("/api/jobs/diff")
async def diff_jobs(a: str = Query(...), b: str = Query(...)):
    base_a = OUTPUT_DIR / a
    base_b = OUTPUT_DIR / b
    if not base_a.exists() or not base_b.exists():
        raise HTTPException(404, "One or both jobs not found")
    # Compare common files; also include only-in-A/B with notes
    files_a = {p.relative_to(base_a).as_posix(): p for p in base_a.rglob("*") if p.is_file()}
    files_b = {p.relative_to(base_b).as_posix(): p for p in base_b.rglob("*") if p.is_file()}
    all_paths = sorted(set(files_a.keys()) | set(files_b.keys()))
    diffs: Dict[str, str] = {}
    for rel in all_paths:
        pa = files_a.get(rel)
        pb = files_b.get(rel)
        if pa and pb:
            try:
                ta = pa.read_text(encoding="utf-8").splitlines()
            except Exception:
                ta = []
            try:
                tb = pb.read_text(encoding="utf-8").splitlines()
            except Exception:
                tb = []
            if ta == tb:
                continue
            ud = difflib.unified_diff(ta, tb, fromfile=f"a/{rel}", tofile=f"b/{rel}", lineterm="")
            diffs[rel] = "\n".join(list(ud))
        elif pa and not pb:
            diffs[rel] = f"(present only in job {a})"
        elif pb and not pa:
            diffs[rel] = f"(present only in job {b})"
    return {"diffs": diffs}

# -----------------------------------------------------------------------------
# Publish feature: create branch, commit, PR via github-hub
# -----------------------------------------------------------------------------

class PublishRequest(BaseModel):
    path_prefix: Optional[str] = Field(default="docs/generated", description="Base path in repo")
    base_branch: Optional[str] = Field(default=None)
    title: Optional[str] = Field(default=None)
    body: Optional[str] = Field(default=None)
    draft: Optional[bool] = Field(default=False)

@app.post("/api/publish/{job_id}")
async def publish_job(job_id: str, body: PublishRequest):
    job = jobs.get(job_id)
    if not job or job.status != "complete" or not job.output_path:
        raise HTTPException(400, "Job not publishable")

    # Load hub config
    cfg = await gh_hub_get_json("/config", None, timeout=20)
    base_branch = body.base_branch or cfg.get("default_branch") or "main"
    # Create branch
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M")
    new_branch = f"docgen/{ts}-{job_id}"

    try:
        await gh_hub_post_json(f"/branch?new={new_branch}&from={base_branch}", payload=None)
    except HTTPException as e:
        # If already exists, ignore; else bubble
        if "Reference already exists" not in str(e.detail):
            raise

    # Build changes from output directory
    output_dir = OUTPUT_DIR / job_id
    if not output_dir.exists():
        raise HTTPException(404, "Output directory missing")

    prefix = (body.path_prefix or "docs/generated").strip("/")

    # Read all files and prepare payload
    changes = []
    for p in output_dir.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(output_dir).as_posix()
        dest_path = f"{prefix}/{job_id}/{rel}"
        try:
            content = p.read_text(encoding="utf-8")
        except Exception:
            content = ""
        changes.append({"path": dest_path, "content": content, "mode": "100644"})

    if not changes:
        raise HTTPException(400, "No files to publish")

    # Batch commit
    commit_msg = f"docs: automated documentation for job {job_id}"
    payload = {"branch": new_branch, "message": commit_msg, "changes": changes}
    await gh_hub_post_json("/batch/commit", payload)

    # Create PR
    pr_title = body.title or f"Automated docs for job {job_id}"
    pr_body = body.body or f"This PR publishes generated documentation from job `{job_id}`."
    pr_payload = {"title": pr_title, "head": new_branch, "base": base_branch, "body": pr_body, "draft": bool(body.draft)}
    pr = await gh_hub_post_json("/pr", pr_payload)
    return {"ok": True, "pull_request": pr.get("pull_request") or pr}

# -----------------------------------------------------------------------------
# Templates editor
# -----------------------------------------------------------------------------

@app.get("/api/templates")
async def list_templates():
    names = set()
    if TEMPLATES_APP_DIR.exists():
        for p in TEMPLATES_APP_DIR.glob("*.md"):
            names.add(p.name)
    if TEMPLATES_DATA_DIR.exists():
        for p in TEMPLATES_DATA_DIR.glob("*.md"):
            names.add(p.name)
    return {"items": sorted(names)}

@app.get("/api/templates/{name}")
async def get_template(name: str):
    if "/" in name or "\\" in name:
        raise HTTPException(400, "Invalid template name")
    content = load_template_by_name(name)
    if content is None:
        raise HTTPException(404, "Template not found")
    return {"name": name, "content": content}

class TemplateSave(BaseModel):
    content: str

@app.put("/api/templates/{name}")
async def save_template(name: str, body: TemplateSave):
    if "/" in name or "\\" in name or not name.endswith(".md"):
        raise HTTPException(400, "Invalid template name (must end with .md)")
    try:
        (TEMPLATES_DATA_DIR).mkdir(parents=True, exist_ok=True)
        (TEMPLATES_DATA_DIR / name).write_text(body.content or "", encoding="utf-8")
        return {"ok": True, "name": name}
    except Exception as e:
        raise HTTPException(500, f"Save failed: {e}")

# -----------------------------------------------------------------------------
# Scheduler API and Webhook
# -----------------------------------------------------------------------------

class ScheduleItem(BaseModel):
    id: str = "default"
    every_seconds: int = 0
    packs: List[str] = Field(default_factory=lambda: ["high-level", "detailed"])
    use_hub: bool = True
    repo_url: Optional[str] = None
    branch: Optional[str] = "main"
    model_key: Optional[str] = None
    model_id: Optional[int] = None
    model_name: Optional[str] = None

class SchedulesIn(BaseModel):
    items: List[ScheduleItem] = Field(default_factory=list)

@app.get("/api/schedules")
async def get_schedules():
    return {"items": read_schedules()}

@app.put("/api/schedules")
async def set_schedules(body: SchedulesIn):
    global _schedules
    items = [i.model_dump() for i in body.items]
    write_schedules(items)
    _schedules = items
    return {"ok": True, "count": len(items)}

@app.post("/api/webhook/github")
async def webhook_github(payload: Dict[str, Any] = Body(...)):
    ref = payload.get("ref") or ""
    if ref == "refs/heads/main":
        # Trigger a default generation on main
        req = DocRequest(repo_url=None, branch="main", packs=["high-level", "detailed"])
        model_ref = {"model_key": None, "model_id": None, "model_name": None}
        await create_job_and_process(req, model_ref)
        return {"ok": True, "triggered": True}
    return {"ok": True, "triggered": False, "ref": ref}

# -----------------------------------------------------------------------------
# Job processing
# -----------------------------------------------------------------------------

async def create_job(request: DocRequest, model_ref: Dict[str, Any]) -> str:
    job_id = hashlib.sha256(f"{(request.repo_url or 'gh-hub')}:{datetime.utcnow().isoformat()}".encode()).hexdigest()[:12]
    job = DocJob(
        id=job_id,
        status="pending",
        progress=0,
        message="Initializing",
        repo_url=request.repo_url,
        branch=request.branch,
        packs=request.packs,
        started_at=datetime.utcnow(),
    )
    jobs[job_id] = job
    return job_id

async def create_job_and_process(request: DocRequest, model_ref: Dict[str, Any]) -> str:
    job_id = await create_job(request, model_ref)
    await process_doc_job(job_id, request, model_ref)
    return job_id

async def process_doc_job(job_id: str, request: DocRequest, model_ref: Dict[str, Any]):
    job = jobs[job_id]
    try:
        # Stage 1: Extract
        job.status = "extracting"
        job.progress = 10
        job.message = "Extracting code artifacts"

        scope = {
            "include_globs": request.include_globs or [],
            "exclude_globs": request.exclude_globs or [],
            "modules": request.modules or [],
            "file_types": request.file_types or [],
            "force_refresh": request.force_refresh or False,
        }
        extractor = CodeExtractor(request.repo_url, request.branch, scope=scope)
        artifacts = await extractor.extract()

        # Stage 2: Normalize
        job.progress = 30
        job.message = "Normalizing and chunking"
        normalizer = ChunkNormalizer(artifacts)
        chunks = normalizer.normalize()

        # Incremental filtering
        if request.incremental:
            prev_meta = find_previous_meta_for_repo_branch(request.repo_url, request.branch)
            if prev_meta:
                changed_paths = compute_changed_paths(prev_meta.get("file_hashes") or {}, artifacts.get("file_hashes") or {})
                chunks = filter_chunks_by_paths(chunks, changed_paths)
                logger.info(f"Incremental mode: {len(changed_paths)} changed paths, {len(chunks)} chunks kept")

        # Stage 3: Generate
        job.status = "generating"
        job.progress = 50
        job.message = "Generating documentation"
        options = {
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "reasoning": request.reasoning,
            "prompt_limit": request.prompt_limit,
        }
        generator = DocGenerator(chunks, model_ref, options)

        all_docs: Dict[str, str] = {}
        total = max(1, len(request.packs))
        for idx, pack_name in enumerate(request.packs):
            pack = DOC_PACKS.get(pack_name)
            if not pack:
                logger.warning(f"Unknown pack: {pack_name}")
                continue
            job.message = f"Generating {pack.name} documentation"
            job.progress = 50 + int(30 * (idx / total))
            extra_prompt = (request.pack_prompts or {}).get(pack.name)
            template_override = (request.per_pack_templates or {}).get(pack.name)
            docs = await generator.generate(pack, job_id, extra_prompt, template_override)
            all_docs.update(docs)

        # Stage 4: Verify
        job.status = "verifying"
        job.progress = 85
        job.message = "Verifying documentation"
        verifier = DocVerifier(all_docs, artifacts)
        verification = await verifier.verify()

        # Save output to job dir
        job.progress = 95
        job.message = "Saving documentation"
        output_path = OUTPUT_DIR / job_id
        output_path.mkdir(parents=True, exist_ok=True)

        # scrub secrets before writing
        for doc_path, content in all_docs.items():
            fp = output_path / doc_path
            fp.parent.mkdir(parents=True, exist_ok=True)
            with open(fp, "w", encoding="utf-8") as f:
                f.write(scrub_secrets(content))

        # Save meta
        meta = {
            "job_id": job_id,
            "repo_url": request.repo_url or None,
            "branch": request.branch,
            "packs": request.packs,
            "file_hashes": artifacts.get("file_hashes") or {},
            "verification": verification,
            "generated_at": datetime.utcnow().isoformat(),
        }
        (output_path / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        # tarball
        tar_path = OUTPUT_DIR / f"{job_id}.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(output_path, arcname="docs")

        job.status = "complete"
        job.progress = 100
        job.message = "Documentation generated successfully"
        job.completed_at = datetime.utcnow()
        job.output_path = str(tar_path)
        logger.info(f"Job {job_id} completed successfully")

    except Exception as e:
        logger.exception(f"Job {job_id} failed")
        job.status = "failed"
        job.error = str(e)
        job.message = f"Failed: {str(e)}"
        job.completed_at = datetime.utcnow()

# -----------------------------------------------------------------------------
# Incremental helpers
# -----------------------------------------------------------------------------

def find_previous_meta_for_repo_branch(repo_url: Optional[str], branch: str) -> Optional[Dict[str, Any]]:
    # Walk recent jobs and find last completed with same repo_url and branch
    for job in sorted(jobs.values(), key=lambda j: j.completed_at or j.started_at, reverse=True):
        if job.status != "complete":
            continue
        if job.branch != branch:
            continue
        if (job.repo_url or None) != (repo_url or None):
            continue
        meta_path = OUTPUT_DIR / job.id / "meta.json"
        if meta_path.exists():
            try:
                return json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
    # fallback: scan directories (in case of restart)
    dirs = [p for p in OUTPUT_DIR.iterdir() if p.is_dir()]
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for d in dirs:
        meta_path = d / "meta.json"
        if meta_path.exists():
            try:
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                if (m.get("repo_url") or None) == (repo_url or None) and m.get("branch") == branch:
                    return m
            except Exception:
                continue
    return None

def compute_changed_paths(prev_hashes: Dict[str, str], cur_hashes: Dict[str, str]) -> List[str]:
    changed = []
    keys = set(prev_hashes.keys()) | set(cur_hashes.keys())
    for k in keys:
        if prev_hashes.get(k) != cur_hashes.get(k):
            changed.append(k)
    return changed

def filter_chunks_by_paths(chunks: List[Dict[str, Any]], paths: List[str]) -> List[Dict[str, Any]]:
    if not paths:
        return []
    ps = set(paths)
    out: List[Dict[str, Any]] = []
    for c in chunks:
        p = c.get("path")
        if not p:
            # keep structure chunk only if there are changes
            if c.get("type") == "structure" and paths:
                out.append(c)
            continue
        if p in ps:
            out.append(c)
    return out

# -----------------------------------------------------------------------------
# Static files
# -----------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="/app/public"), name="static")

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 3030)))