
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
# Stage 1: Extractor
# -----------------------------------------------------------------------------

class CodeExtractor:
    def __init__(self, repo_url: Optional[str], branch: str, scope: Dict[str, Any]):
        self.repo_url = repo_url
        self.branch = branch
        self.scope = scope or {}
        repo_id = self.repo_url or "github-hub-default"
        self.cache_key = hashlib.sha256(f"{repo_id}:{branch}".encode()).hexdigest()

    def _is_allowed_by_scope(self, path: str) -> bool:
        # file_types filter (extensions without dot)
        exts = [e.lower().strip(".") for e in (self.scope.get("file_types") or []) if e]
        if exts:
            ext = path.split(".")[-1].lower() if "." in path else ""
            if ext not in exts:
                return False

        # modules filter (assumes paths like modules/<name>/...)
        mods = [m.strip() for m in (self.scope.get("modules") or []) if m]
        if mods:
            ok = False
            for m in mods:
                if path.startswith(f"modules/{m}/"):
                    ok = True
                    break
            if not ok:
                return False

        # include globs
        inc = [g for g in (self.scope.get("include_globs") or []) if g]
        if inc:
            if not any(fnmatch.fnmatch(path, g) for g in inc):
                return False

        # exclude globs
        exc = [g for g in (self.scope.get("exclude_globs") or []) if g]
        if exc:
            if any(fnmatch.fnmatch(path, g) for g in exc):
                return False

        return True

    async def extract(self) -> Dict[str, Any]:
        logger.info(f"Extracting from {self.repo_url or '[github-hub repo]'}@{self.branch}")
        cache_file = CACHE_DIR / f"{self.cache_key}.json"
        if cache_file.exists() and not self.scope.get("force_refresh"):
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass

        # Load tree
        tree = await fetch_repo_tree(self.repo_url, self.branch)
        items = tree.get("items", []) or []

        artifacts = {
            "meta": {
                "repo": self.repo_url or "(via github-hub config)",
                "branch": self.branch,
                "extracted_at": datetime.utcnow().isoformat(),
            },
            "structure": self._build_structure(items),
            "files": {},
            "api_specs": {},
            "configs": {},
            "schemas": {},
            "tests": [],
            "file_hashes": {},
        }

        # Process files
        for item in items:
            if item.get("type") != "blob":
                continue
            path = item.get("path")
            if not path or not self._is_allowed_by_scope(path):
                continue

            # API specs
            if re.match(r".*\.(yaml|yml|json)$", path, re.I):
                if "openapi" in path.lower() or "swagger" in path.lower():
                    content = await fetch_file_content(path, self.branch, self.repo_url)
                    artifacts["api_specs"][path] = self._parse_openapi(content)
                    artifacts["file_hashes"][path] = sha256_text(content)
                    continue

            # Schemas
            if path.endswith(".sql"):
                content = await fetch_file_content(path, self.branch, self.repo_url)
                artifacts["schemas"][path] = content
                artifacts["file_hashes"][path] = sha256_text(content)
                continue

            # Deployment configs
            if "docker" in path.lower() or path.lower().endswith("docker-compose.yml"):
                content = await fetch_file_content(path, self.branch, self.repo_url)
                artifacts["configs"][path] = content
                artifacts["file_hashes"][path] = sha256_text(content)
                continue

            # Tests
            if "test" in path.lower() or "spec" in path.lower():
                artifacts["tests"].append(path)
                continue

            # Key source files
            if self._is_key_source_file(path):
                content = await fetch_file_content(path, self.branch, self.repo_url)
                artifacts["files"][path] = {
                    "content": content,
                    "language": self._detect_language(path),
                    "symbols": self._extract_symbols(content, path),
                }
                artifacts["file_hashes"][path] = sha256_text(content)

        # Cache artifacts
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(artifacts, f, indent=2)
        except Exception:
            pass

        return artifacts

    def _build_structure(self, items: List[Dict]) -> Dict:
        root = {"type": "dir", "children": {}}
        for item in items:
            p = item.get("path") or ""
            if not p:
                continue
            parts = p.split("/")
            cur = root
            for i, seg in enumerate(parts):
                is_last = i == len(parts) - 1
                if is_last:
                    if item.get("type") == "blob":
                        cur["children"][seg] = {"type": "file", "size": item.get("size", 0)}
                    else:
                        cur["children"][seg] = {"type": "dir", "children": {}}
                else:
                    if seg not in cur["children"]:
                        cur["children"][seg] = {"type": "dir", "children": {}}
                    cur = cur["children"][seg]
        return root

    def _is_key_source_file(self, path: str) -> bool:
        key_patterns = [
            r".*/(index|main|app|server)\.(js|ts|py|go|java)$",
            r".*/routes/.*\.(js|ts|py)$",
            r".*/models/.*\.(js|ts|py)$",
            r".*/api/.*\.(js|ts|py)$",
        ]
        return any(re.match(p, path) for p in key_patterns)

    def _detect_language(self, path: str) -> str:
        ext = path.split(".")[-1].lower()
        mapping = {
            "js": "javascript", "ts": "typescript", "py": "python",
            "go": "go", "java": "java", "rb": "ruby", "rs": "rust",
            "json": "json", "yaml": "yaml", "yml": "yaml", "sql": "sql",
            "md": "markdown",
        }
        return mapping.get(ext, "unknown")

    def _extract_symbols(self, content: str, path: str) -> List[str]:
        symbols: List[str] = []
        lang = self._detect_language(path)
        if lang in ["javascript", "typescript"]:
            symbols.extend(re.findall(r"(?:function|const|let|var|class)\s+(\w+)", content))
            symbols.extend(re.findall(r"(\w+)\s*:\s*(?:async\s*)?\(", content))
        elif lang == "python":
            symbols.extend(re.findall(r"^(?:def|class)\s+(\w+)", content, re.MULTILINE))
        # dedupe
        seen = set()
        out = []
        for s in symbols:
            if s not in seen:
                seen.add(s)
                out.append(s)
        return out[:50]

    def _parse_openapi(self, content: str) -> Dict:
        try:
            if not content:
                return {}
            if content.strip().startswith("{"):
                spec = json.loads(content)
            else:
                spec = yaml.safe_load(content)
            return {
                "version": spec.get("openapi", spec.get("swagger", "unknown")),
                "paths": list(spec.get("paths", {}).keys()),
                "schemas": list(spec.get("components", {}).get("schemas", {}).keys()),
            }
        except Exception:
            return {}

# -----------------------------------------------------------------------------
# Stage 2: Normalizer
# -----------------------------------------------------------------------------

class ChunkNormalizer:
    def __init__(self, artifacts: Dict[str, Any]):
        self.artifacts = artifacts

    def normalize(self) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []
        chunks.append({
            "type": "structure",
            "content": self._format_structure(self.artifacts["structure"]),
            "metadata": {
                "repo": self.artifacts["meta"]["repo"],
                "branch": self.artifacts["meta"]["branch"],
            },
        })

        for path, spec in self.artifacts.get("api_specs", {}).items():
            chunks.append({
                "type": "api_spec",
                "path": path,
                "content": json.dumps(spec, indent=2),
                "metadata": {"version": spec.get("version")},
            })

        for path, file_info in self.artifacts.get("files", {}).items():
            content = file_info.get("content") or ""
            if len(content) > 5000:
                sub_chunks = self._smart_chunk(content, file_info.get("language"))
                for i, sub in enumerate(sub_chunks):
                    chunks.append({
                        "type": "source",
                        "path": path,
                        "part": i + 1,
                        "content": sub,
                        "language": file_info.get("language"),
                        "symbols": file_info.get("symbols") or [],
                    })
            else:
                chunks.append({
                    "type": "source",
                    "path": path,
                    "content": content,
                    "language": file_info.get("language"),
                    "symbols": file_info.get("symbols") or [],
                })

        for path, content in self.artifacts.get("schemas", {}).items():
            chunks.append({
                "type": "schema",
                "path": path,
                "content": content or "",
            })
        return chunks

    def _format_structure(self, node: Dict, indent: int = 0) -> str:
        lines: List[str] = []
        for name, child in (node.get("children") or {}).items():
            pre = "  " * indent
            if child["type"] == "file":
                lines.append(f"{pre}📄 {name}")
            else:
                lines.append(f"{pre}📁 {name}")
                lines.append(self._format_structure(child, indent + 1))
        return "\n".join(lines)

    def _smart_chunk(self, content: str, language: str, max_size: int = 3000) -> List[str]:
        chunks: List[str] = []
        current: List[str] = []
        size = 0
        for line in (content or "").split("\n"):
            is_boundary = False
            if language in ["python"] and re.match(r"^(def|class)\s+", line):
                is_boundary = True
            elif language in ["javascript", "typescript"] and re.match(r"^(function|class|export)\s+", line):
                is_boundary = True
            if is_boundary and size > max_size / 2:
                chunks.append("\n".join(current))
                current, size = [], 0
            current.append(line)
            size += len(line)
            if size > max_size:
                chunks.append("\n".join(current))
                current, size = [], 0
        if current:
            chunks.append("\n".join(current))
        return chunks

# -----------------------------------------------------------------------------
# Stage 3: Generator
# -----------------------------------------------------------------------------

def sha256_text(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()

def load_template_by_name(name: str) -> Optional[str]:
    # Prefer data dir override, then app dir
    p1 = TEMPLATES_DATA_DIR / name
    if p1.exists():
        try:
            return p1.read_text(encoding="utf-8")
        except Exception:
            pass
    p2 = TEMPLATES_APP_DIR / name
    if p2.exists():
        try:
            return p2.read_text(encoding="utf-8")
        except Exception:
            pass
    return None

def default_template_for(name: str) -> str:
    fallback = {
        "super_detailed.md": """You are a senior engineer documenting production systems. Only state facts grounded in the provided context.

Context:
{context}

Task: Produce super-detailed documentation for this module including: purpose, public API, invariants, errors, performance, security, dependencies, tests, extension points.
Cite file:line where applicable.""",
        "high_level.md": """Create a high-level system overview based on the provided codebase.

Context:
{context}

Include: problem statement, architecture overview, data flow, security model, key decisions. Markdown format.""",
        "api_reference.md": """Generate API reference documentation from the provided specification.

Context:
{context}

For each endpoint: method+path, auth, request schema, response schema, examples (curl & JS), rate limits. Markdown.""",
        "db_schema.md": """Document the database schema from the provided SQL.

Context:
{context}

Include: tables+purpose, relationships, indexes, retention, common queries, and an ERD in Mermaid.""",
        "detailed.md": """Generate detailed component-level documentation.

Context:
{context}

Include: component summary, architecture, interfaces, configuration, key workflows, error handling, observability, dependencies, deployment, maintenance. Markdown.""",
        "operations.md": """Generate DevOps/SRE documentation.

Context:
{context}

Include: deployment architecture, CI/CD, environments, container/orchestration configs, monitoring/logging/tracing, runbooks, security ops, capacity, maintenance. Markdown.""",
        "cookbook.md": """Create practical how-to guides.

Context:
{context}

Include: quick start, common tasks with steps, verification, related tasks, troubleshooting, automation scripts, tips & tricks. Markdown.""",
    }
    return fallback.get(name, fallback["high_level.md"])

def scrub_secrets(text: str) -> str:
    if not text:
        return text
    patterns = [
        r"AKIA[0-9A-Z]{16}",
        r"ghp_[0-9A-Za-z]{20,}",
        r"sk-[0-9A-Za-z]{20,}",
        r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----",
        r"(?i)password\s*[:=]\s*.+",
        r"(?i)api[_-]?key\s*[:=]\s*.+",
        r"(?i)secret\s*[:=]\s*.+",
    ]
    out = text
    for pat in patterns:
        out = re.sub(pat, "[REDACTED]", out)
    return out

class DocGenerator:
    def __init__(self, chunks: List[Dict], model_ref: Dict[str, Any], options: Dict[str, Any]):
        self.chunks = chunks or []
        self.model_ref = model_ref or {}
        self.options = options or {}

    def _load_template(self, pack: DocPack, override_name: Optional[str]) -> str:
        name = override_name or pack.template
        content = load_template_by_name(name)
        if content:
            return content
        return default_template_for(name)

    def _filter_chunks_for_pack(self, pack: DocPack) -> List[Dict]:
        if pack.name == "api":
            return [c for c in self.chunks if c["type"] in ["api_spec", "source"] and "api" in c.get("path", "").lower()]
        elif pack.name == "db":
            return [c for c in self.chunks if c["type"] == "schema"]
        elif pack.name in ["super-detailed", "detailed"]:
            return [c for c in self.chunks if c["type"] == "source"]
        return self.chunks

    def _merge_chunks(self, chunks: List[Dict], prompt_limit: int) -> str:
        parts: List[str] = []
        budget = max(1000, int(prompt_limit or 8000))
        used = 0
        for chunk in chunks:
            if chunk["type"] == "source":
                segment = f"=== {chunk['path']} ===\nLanguage: {chunk.get('language','unknown')}\n{(chunk.get('content') or '')}\n"
            elif chunk["type"] == "api_spec":
                segment = f"=== API Spec: {chunk['path']} ===\n{(chunk.get('content') or '')}\n"
            elif chunk["type"] == "schema":
                segment = f"=== Schema: {chunk['path']} ===\n{(chunk.get('content') or '')}\n"
            elif chunk["type"] == "structure":
                segment = f"=== Repository Structure ===\n{(chunk.get('content') or '')}\n"
            else:
                segment = str(chunk.get("content") or "")
            seg_len = len(segment)
            if used + seg_len > budget:
                segment = segment[: max(0, budget - used)]
                parts.append(segment)
                break
            parts.append(segment)
            used += seg_len
        return "\n".join(parts)

    async def generate(self, pack: DocPack, job_id: str, extra_prompt: Optional[str], template_override: Optional[str]) -> Dict[str, str]:
        template = self._load_template(pack, template_override)
        relevant = self._filter_chunks_for_pack(pack)

        docs: Dict[str, str] = {}
        if pack.name == "api":
            api_chunks = [c for c in relevant if c["type"] == "api_spec"]
            for chunk in api_chunks:
                ctx = chunk  # keep compact
                doc = await self._call_llm(template, ctx, extra_prompt)
                endpoint_group = chunk["path"].split("/")[-1].replace(".yaml", "").replace(".yml", "").replace(".json", "")
                docs[f"api/{endpoint_group}.md"] = doc
        elif pack.name in ["super-detailed", "detailed"]:
            source_chunks = [c for c in relevant if c["type"] == "source"]
            components: Dict[str, List[Dict]] = {}
            for c in source_chunks:
                comp = self._extract_component_name(c.get("path", ""))
                components.setdefault(comp, []).append(c)
            for comp, comp_chunks in components.items():
                context = self._merge_chunks(comp_chunks, int(self.options.get("prompt_limit") or 8000))
                doc = await self._call_llm(template, context, extra_prompt)
                docs[f"components/{comp}.md"] = doc
        else:
            context = self._merge_chunks(relevant, int(self.options.get("prompt_limit") or 8000))
            doc = await self._call_llm(template, context, extra_prompt)
            docs[pack.output_path] = doc
        return docs

    def _extract_component_name(self, path: str) -> str:
        parts = path.split("/")
        if "modules" in parts:
            idx = parts.index("modules")
            if idx + 1 < len(parts):
                return parts[idx + 1]
        if "src" in parts:
            idx = parts.index("src")
            if idx + 1 < len(parts):
                return parts[idx + 1]
        return parts[-2] if len(parts) > 1 else "main"

    async def _call_llm(self, template: str, context: Any, extra_prompt: Optional[str]) -> str:
        if isinstance(context, dict):
            ctx = json.dumps(context, indent=2)
        else:
            ctx = str(context or "")
        ctx = ctx[: int(self.options.get("prompt_limit") or 8000)]

        prompt = template.format(context=ctx)
        if extra_prompt:
            prompt = f"{prompt}\n\nAdditional instructions:\n{extra_prompt}"

        messages = [
            {"role": "system", "content": "You are a technical documentation expert. Generate comprehensive, accurate documentation based on the provided code context."},
            {"role": "user", "content": prompt},
        ]

        payload: Dict[str, Any] = {
            "messages": messages,
            "temperature": float(self.options.get("temperature") if self.options.get("temperature") is not None else 0.3),
            "max_tokens": int(self.options.get("max_tokens") or 4000),
            "stream": False,
        }
        if bool(self.options.get("reasoning")):
            payload["reasoning"] = True

        mk = self.model_ref.get("model_key") or self.model_ref.get("model")
        mid = self.model_ref.get("model_id")
        mname = self.model_ref.get("model_name")
        if mid is not None:
            payload["modelId"] = mid
        elif mk:
            payload["modelKey"] = mk
        elif mname:
            payload["model"] = mname

        async with aiohttp.ClientSession() as session:
            async with session.post(f"{LLM_GATEWAY_URL}/v1/chat", json=payload, timeout=180) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"LLM Gateway error: {error_text}")
                    try:
                        data = json.loads(error_text)
                        msg = data.get("error", error_text)
                    except Exception:
                        msg = error_text
                    return f"# Documentation Generation Failed\n\nError: {msg}"
                result = await resp.json()
                if isinstance(result, dict) and "content" in result:
                    return result.get("content") or "# Empty content"
                try:
                    text = result.get("text") or result.get("content") or ""
                    if text:
                        return str(text)
                except Exception:
                    pass
                return "# No content generated"

# -----------------------------------------------------------------------------
# Stage 4: Verifier
# -----------------------------------------------------------------------------

class DocVerifier:
    def __init__(self, docs: Dict[str, str], artifacts: Dict):
        self.docs = docs or {}
        self.artifacts = artifacts or {}

    def _find_mermaid_blocks(self, text: str) -> List[str]:
        blocks = []
        if not text:
            return blocks
        # ```mermaid ... ```
        matches = re.findall(r"```mermaid\s+([\s\S]*?)```", text, re.MULTILINE)
        blocks.extend(matches)
        return blocks

    def _check_links(self, text: str) -> List[str]:
        warnings: List[str] = []
        if not text:
            return warnings
        # [title](link)
        links = re.findall(r"\[[^\]]*?\]\(([^)]+)\)", text)
        for link in links:
            if link.startswith("http://") or link.startswith("https://"):
                continue
            # relative: Can't fully validate here; skip
            if not link.strip():
                warnings.append("Empty markdown link target")
        return warnings

    def _coverage(self, docs: Dict[str, str], artifacts: Dict[str, Any]) -> Dict[str, Any]:
        total_source = len(artifacts.get("files", {}))
        generated_components = sum(1 for k in docs.keys() if k.startswith("components/") and k.endswith(".md"))
        return {
            "total_source_files": total_source,
            "generated_component_docs": generated_components,
            "coverage_ratio": (generated_components / total_source) if total_source > 0 else None,
        }

    async def verify(self) -> Dict[str, Any]:
        results = {"checks": [], "warnings": [], "errors": [], "coverage": {}}
        # basic checks per file
        for path, content in self.docs.items():
            if len(content or "") < 100:
                results["errors"].append(f"{path}: Documentation too short")
            if not (content or "").startswith("#"):
                results["warnings"].append(f"{path}: Missing header")

            # links
            results["warnings"].extend([f"{path}: {w}" for w in self._check_links(content or "")])

            # mermaid sanity
            for blk in self._find_mermaid_blocks(content or ""):
                if not blk.strip():
                    results["warnings"].append(f"{path}: Empty mermaid block")

        results["coverage"] = self._coverage(self.docs, self.artifacts)
        return results

# -----------------------------------------------------------------------------
# Extraction facade methods
# -----------------------------------------------------------------------------

async def fetch_repo_tree(repo_url: Optional[str], branch: str) -> Dict[str, Any]:
    if not repo_url:
        return await gh_hub_get_json("/tree", params={"branch": branch, "recursive": "true"}, timeout=90)
    token = _read_github_token()
    owner, repo = parse_repo(repo_url)
    async with aiohttp.ClientSession() as session:
        return await gh_direct_get_tree(session, owner, repo, branch, token)

async def fetch_file_content(path: str, branch: str, repo_url: Optional[str]) -> str:
    if not repo_url:
        async with aiohttp.ClientSession() as session:
            params = {"path": path, "branch": branch}
            async with session.get(f"{GITHUB_HUB_URL}/file", params=params, timeout=60) as resp:
                if resp.status != 200:
                    return ""
                data = await resp.json()
                return data.get("decoded_content", "")
    token = _read_github_token()
    owner, repo = parse_repo(repo_url)
    async with aiohttp.ClientSession() as session:
        return await gh_direct_get_file(session, owner, repo, path, branch, token)

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