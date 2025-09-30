"""
LLM Documentation Generator Service
Automated documentation generation for code repositories
"""
import os
import json
import asyncio
import hashlib
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime
import aiohttp
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import yaml
import re
from loguru import logger

# Configure logger
logger.add("logs/llm-documentor.log", rotation="10 MB")

app = FastAPI(title="LLM Documentor", version="0.1.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
GITHUB_HUB_URL = os.getenv("GITHUB_HUB_URL", "http://github-hub-module:3005/api")
LLM_GATEWAY_URL = os.getenv("LLM_GATEWAY_URL", "http://llm-gateway:3010/api")
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
OUTPUT_DIR = DATA_DIR / "output"
CACHE_DIR = DATA_DIR / "cache"
TEMPLATES_DIR = Path("/app/templates")

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ============= Models =============

class DocPack(BaseModel):
    """Documentation package definition"""
    name: str = Field(..., description="Package identifier")
    description: str = Field(..., description="Package description")
    audience: str = Field(..., description="Target audience")
    template: str = Field(..., description="Prompt template name")
    output_path: str = Field(..., description="Output file path pattern")
    
class DocRequest(BaseModel):
    """Documentation generation request"""
    repo_url: str = Field(..., description="Repository URL")
    branch: str = Field(default="main", description="Branch to document")
    packs: List[str] = Field(default=["high-level", "api", "components"], description="Doc packs to generate")
    model_key: str = Field(default="openai:gpt-4o-mini", description="LLM model to use")
    force_refresh: bool = Field(default=False, description="Ignore cache")
    
class DocJob(BaseModel):
    """Background job status"""
    id: str
    status: str  # pending, extracting, generating, verifying, complete, failed
    progress: int  # 0-100
    message: str
    repo_url: str
    branch: str
    packs: List[str]
    started_at: datetime
    completed_at: Optional[datetime] = None
    output_path: Optional[str] = None
    error: Optional[str] = None

# ============= State Management =============

# In-memory job tracking (production would use Redis/DB)
jobs: Dict[str, DocJob] = {}

# Documentation pack definitions
DOC_PACKS = {
    "super-detailed": DocPack(
        name="super-detailed",
        description="Per-module deep technical documentation",
        audience="engineers",
        template="super_detailed.md",
        output_path="components/{module}.md"
    ),
    "detailed": DocPack(
        name="detailed", 
        description="Component-level documentation",
        audience="development team",
        template="detailed.md",
        output_path="components/{service}.md"
    ),
    "high-level": DocPack(
        name="high-level",
        description="System overview and architecture",
        audience="stakeholders",
        template="high_level.md",
        output_path="overview/SYSTEM_OVERVIEW.md"
    ),
    "api": DocPack(
        name="api",
        description="API reference documentation",
        audience="developers",
        template="api_reference.md", 
        output_path="api/{endpoint_group}.md"
    ),
    "db": DocPack(
        name="db",
        description="Database schema documentation",
        audience="engineers",
        template="db_schema.md",
        output_path="db/SCHEMA.md"
    ),
    "ops": DocPack(
        name="ops",
        description="Operations and deployment guides",
        audience="devops",
        template="operations.md",
        output_path="ops/{topic}.md"
    ),
    "cookbook": DocPack(
        name="cookbook",
        description="How-to guides and recipes",
        audience="developers",
        template="cookbook.md",
        output_path="guides/COOKBOOK.md"
    )
}

# ============= GitHub Hub Integration =============

async def fetch_repo_tree(repo_url: str, branch: str) -> Dict[str, Any]:
    """Fetch repository structure from GitHub Hub"""
    async with aiohttp.ClientSession() as session:
        # Get repository tree
        params = {"branch": branch, "recursive": "true"}
        async with session.get(f"{GITHUB_HUB_URL}/tree", params=params) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=resp.status, detail="Failed to fetch repo tree")
            data = await resp.json()
            return data

async def fetch_file_content(path: str, branch: str) -> str:
    """Fetch file content from GitHub Hub"""
    async with aiohttp.ClientSession() as session:
        params = {"path": path, "branch": branch}
        async with session.get(f"{GITHUB_HUB_URL}/file", params=params) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json()
            return data.get("decoded_content", "")

# ============= Stage 1: Extractor =============

class CodeExtractor:
    """Extract structured information from codebase"""
    
    def __init__(self, repo_url: str, branch: str):
        self.repo_url = repo_url
        self.branch = branch
        self.cache_key = hashlib.sha256(f"{repo_url}:{branch}".encode()).hexdigest()
        
    async def extract(self) -> Dict[str, Any]:
        """Extract code artifacts and metadata"""
        logger.info(f"Extracting from {self.repo_url}@{self.branch}")
        
        # Check cache
        cache_file = CACHE_DIR / f"{self.cache_key}.json"
        if cache_file.exists():
            logger.info("Using cached extraction")
            with open(cache_file, 'r') as f:
                return json.load(f)
        
        tree = await fetch_repo_tree(self.repo_url, self.branch)
        items = tree.get("items", [])
        
        artifacts = {
            "meta": {
                "repo": self.repo_url,
                "branch": self.branch,
                "extracted_at": datetime.utcnow().isoformat()
            },
            "structure": self._build_structure(items),
            "files": {},
            "api_specs": {},
            "configs": {},
            "schemas": {},
            "tests": []
        }
        
        # Process files by type
        for item in items:
            if item["type"] != "blob":
                continue
                
            path = item["path"]
            
            # API specs (OpenAPI, GraphQL)
            if re.match(r".*\.(yaml|yml|json)$", path, re.I):
                if "openapi" in path.lower() or "swagger" in path.lower():
                    content = await fetch_file_content(path, self.branch)
                    artifacts["api_specs"][path] = self._parse_openapi(content)
                    
            # Database schemas
            elif path.endswith(".sql"):
                content = await fetch_file_content(path, self.branch)
                artifacts["schemas"][path] = content
                
            # Docker/deployment configs
            elif "docker" in path.lower() or path.endswith("docker-compose.yml"):
                content = await fetch_file_content(path, self.branch)
                artifacts["configs"][path] = content
                
            # Test files
            elif "test" in path.lower() or "spec" in path.lower():
                artifacts["tests"].append(path)
                
            # Source code files (sample key files only)
            elif self._is_key_source_file(path):
                content = await fetch_file_content(path, self.branch)
                artifacts["files"][path] = {
                    "content": content,
                    "language": self._detect_language(path),
                    "symbols": self._extract_symbols(content, path)
                }
        
        # Cache the extraction
        with open(cache_file, 'w') as f:
            json.dump(artifacts, f, indent=2)
            
        return artifacts
    
    def _build_structure(self, items: List[Dict]) -> Dict:
        """Build hierarchical file structure"""
        root = {"type": "dir", "children": {}}
        
        for item in items:
            parts = item["path"].split("/")
            current = root
            
            for i, part in enumerate(parts):
                if i == len(parts) - 1:
                    # Leaf node
                    if item["type"] == "blob":
                        current["children"][part] = {"type": "file", "size": item.get("size", 0)}
                    else:
                        current["children"][part] = {"type": "dir", "children": {}}
                else:
                    # Directory node
                    if part not in current["children"]:
                        current["children"][part] = {"type": "dir", "children": {}}
                    current = current["children"][part]
                    
        return root
    
    def _is_key_source_file(self, path: str) -> bool:
        """Identify key source files to extract"""
        key_patterns = [
            r".*/(index|main|app|server)\.(js|ts|py|go|java)$",
            r".*/routes/.*\.(js|ts|py)$", 
            r".*/models/.*\.(js|ts|py)$",
            r".*/api/.*\.(js|ts|py)$"
        ]
        return any(re.match(p, path) for p in key_patterns)
    
    def _detect_language(self, path: str) -> str:
        """Detect programming language from file extension"""
        ext = path.split(".")[-1].lower()
        mapping = {
            "js": "javascript", "ts": "typescript", "py": "python",
            "go": "go", "java": "java", "rb": "ruby", "rs": "rust"
        }
        return mapping.get(ext, "unknown")
    
    def _extract_symbols(self, content: str, path: str) -> List[str]:
        """Extract function/class names (basic regex approach)"""
        symbols = []
        lang = self._detect_language(path)
        
        if lang in ["javascript", "typescript"]:
            # Functions and classes
            symbols.extend(re.findall(r"(?:function|const|let|var|class)\s+(\w+)", content))
            symbols.extend(re.findall(r"(\w+)\s*:\s*(?:async\s*)?\(", content))  # methods
            
        elif lang == "python":
            symbols.extend(re.findall(r"^(?:def|class)\s+(\w+)", content, re.MULTILINE))
            
        return list(set(symbols))[:50]  # Limit to top 50 unique symbols
    
    def _parse_openapi(self, content: str) -> Dict:
        """Parse OpenAPI spec (basic extraction)"""
        try:
            if content.strip().startswith("{"):
                spec = json.loads(content)
            else:
                spec = yaml.safe_load(content)
            
            return {
                "version": spec.get("openapi", spec.get("swagger", "unknown")),
                "paths": list(spec.get("paths", {}).keys()),
                "schemas": list(spec.get("components", {}).get("schemas", {}).keys())
            }
        except:
            return {}

# ============= Stage 2: Normalizer =============

class ChunkNormalizer:
    """Normalize and chunk code artifacts for LLM consumption"""
    
    def __init__(self, artifacts: Dict[str, Any]):
        self.artifacts = artifacts
        
    def normalize(self) -> List[Dict[str, Any]]:
        """Create semantic chunks with metadata"""
        chunks = []
        
        # Structure overview chunk
        chunks.append({
            "type": "structure",
            "content": self._format_structure(self.artifacts["structure"]),
            "metadata": {
                "repo": self.artifacts["meta"]["repo"],
                "branch": self.artifacts["meta"]["branch"]
            }
        })
        
        # API specification chunks
        for path, spec in self.artifacts["api_specs"].items():
            chunks.append({
                "type": "api_spec",
                "path": path,
                "content": json.dumps(spec, indent=2),
                "metadata": {"version": spec.get("version")}
            })
            
        # Source file chunks
        for path, file_info in self.artifacts["files"].items():
            # Chunk large files
            content = file_info["content"]
            if len(content) > 5000:
                # Split into logical chunks (by function/class)
                sub_chunks = self._smart_chunk(content, file_info["language"])
                for i, chunk_content in enumerate(sub_chunks):
                    chunks.append({
                        "type": "source",
                        "path": path,
                        "part": i + 1,
                        "content": chunk_content,
                        "language": file_info["language"],
                        "symbols": file_info["symbols"]
                    })
            else:
                chunks.append({
                    "type": "source",
                    "path": path,
                    "content": content,
                    "language": file_info["language"],
                    "symbols": file_info["symbols"]
                })
                
        # Schema chunks
        for path, content in self.artifacts["schemas"].items():
            chunks.append({
                "type": "schema",
                "path": path,
                "content": content
            })
            
        return chunks
    
    def _format_structure(self, node: Dict, indent: int = 0) -> str:
        """Format file structure as tree"""
        lines = []
        
        for name, child in node.get("children", {}).items():
            prefix = "  " * indent
            if child["type"] == "file":
                lines.append(f"{prefix}📄 {name}")
            else:
                lines.append(f"{prefix}📁 {name}")
                lines.append(self._format_structure(child, indent + 1))
                
        return "\n".join(lines)
    
    def _smart_chunk(self, content: str, language: str, max_size: int = 3000) -> List[str]:
        """Intelligently chunk code by logical boundaries"""
        chunks = []
        current_chunk = []
        current_size = 0
        
        lines = content.split("\n")
        
        for line in lines:
            # Detect logical boundaries
            is_boundary = False
            if language in ["python"] and re.match(r"^(def|class)\s+", line):
                is_boundary = True
            elif language in ["javascript", "typescript"] and re.match(r"^(function|class|export)\s+", line):
                is_boundary = True
                
            # Start new chunk if needed
            if is_boundary and current_size > max_size / 2:
                chunks.append("\n".join(current_chunk))
                current_chunk = []
                current_size = 0
                
            current_chunk.append(line)
            current_size += len(line)
            
            if current_size > max_size:
                chunks.append("\n".join(current_chunk))
                current_chunk = []
                current_size = 0
                
        if current_chunk:
            chunks.append("\n".join(current_chunk))
            
        return chunks

# ============= Stage 3: Generator =============

class DocGenerator:
    """Generate documentation using LLM"""
    
    def __init__(self, chunks: List[Dict], model_key: str):
        self.chunks = chunks
        self.model_key = model_key
        
    async def generate(self, pack: DocPack, job_id: str) -> Dict[str, str]:
        """Generate documentation for a specific pack"""
        logger.info(f"Generating {pack.name} documentation")
        
        # Load prompt template
        template = self._load_template(pack.template)
        
        # Group chunks by relevance to this pack
        relevant_chunks = self._filter_chunks_for_pack(pack)
        
        # Generate documentation sections
        docs = {}
        
        if pack.name == "api":
            # Generate per-endpoint documentation
            api_chunks = [c for c in relevant_chunks if c["type"] == "api_spec"]
            for chunk in api_chunks:
                doc = await self._call_llm(template, chunk, pack)
                endpoint_group = chunk["path"].split("/")[-1].replace(".yaml", "")
                docs[f"api/{endpoint_group}.md"] = doc
                
        elif pack.name in ["super-detailed", "detailed"]:
            # Generate per-module/component documentation
            source_chunks = [c for c in relevant_chunks if c["type"] == "source"]
            
            # Group by component
            components = {}
            for chunk in source_chunks:
                component = self._extract_component_name(chunk["path"])
                if component not in components:
                    components[component] = []
                components[component].append(chunk)
                
            for component, comp_chunks in components.items():
                context = self._merge_chunks(comp_chunks)
                doc = await self._call_llm(template, context, pack)
                docs[f"components/{component}.md"] = doc
                
        else:
            # Generate single document for the pack
            context = self._merge_chunks(relevant_chunks)
            doc = await self._call_llm(template, context, pack)
            docs[pack.output_path] = doc
            
        return docs
    
    def _load_template(self, template_name: str) -> str:
        """Load prompt template"""
        # Default templates (would be loaded from files in production)
        templates = {
            "super_detailed.md": """You are a senior engineer documenting production systems. Only state facts grounded in the provided context. 

Context:
{context}

Task: Produce super-detailed documentation for this module including:
- Purpose and responsibilities  
- Public API (functions/classes) with signatures
- Preconditions, invariants, edge cases
- Error handling (exceptions, codes)
- Performance considerations and complexity
- Security and privacy considerations
- Dependencies (internal/external)
- How to test and extend

Cite sources as file:line where applicable.""",

            "high_level.md": """Create a high-level system overview based on the provided codebase:

Context:
{context}

Include:
- Problem statement and users
- Architecture overview (describe components)
- Data flow at 10,000 ft
- Security model
- Key design decisions

Format as clean Markdown suitable for stakeholders.""",

            "api_reference.md": """Generate API reference documentation from the provided specification:

Context:
{context}

For each endpoint include:
- Path, method, authentication
- Request model (fields, types, validation)
- Response models (success/error)
- Examples (curl and SDK)
- Rate limits and pagination

Format as developer-friendly Markdown.""",

            "db_schema.md": """Document the database schema from the provided SQL:

Context:
{context}

Include:
- Tables with purpose and key columns
- Relationships and foreign keys
- Indexes and their rationale
- Data retention policies
- Common query patterns

Add an ERD diagram in Mermaid format."""
        }
        
        return templates.get(template_name, templates["high_level.md"])
    
    def _filter_chunks_for_pack(self, pack: DocPack) -> List[Dict]:
        """Select relevant chunks for documentation pack"""
        if pack.name == "api":
            return [c for c in self.chunks if c["type"] in ["api_spec", "source"] and "api" in c.get("path", "").lower()]
        elif pack.name == "db":
            return [c for c in self.chunks if c["type"] in ["schema"]]
        elif pack.name in ["super-detailed", "detailed"]:
            return [c for c in self.chunks if c["type"] == "source"]
        else:
            # High-level uses everything
            return self.chunks
    
    def _merge_chunks(self, chunks: List[Dict]) -> str:
        """Merge multiple chunks into context string"""
        parts = []
        
        for chunk in chunks[:10]:  # Limit context size
            if chunk["type"] == "source":
                parts.append(f"=== {chunk['path']} ===\nLanguage: {chunk['language']}\n{chunk['content'][:2000]}\n")
            elif chunk["type"] == "api_spec":
                parts.append(f"=== API Spec: {chunk['path']} ===\n{chunk['content'][:2000]}\n")
            elif chunk["type"] == "schema":
                parts.append(f"=== Schema: {chunk['path']} ===\n{chunk['content'][:2000]}\n")
            elif chunk["type"] == "structure":
                parts.append(f"=== Repository Structure ===\n{chunk['content'][:1000]}\n")
                
        return "\n".join(parts)
    
    def _extract_component_name(self, path: str) -> str:
        """Extract component name from file path"""
        parts = path.split("/")
        
        # Look for common patterns
        if "modules" in parts:
            idx = parts.index("modules")
            if idx + 1 < len(parts):
                return parts[idx + 1]
                
        if "src" in parts:
            idx = parts.index("src")
            if idx + 1 < len(parts):
                return parts[idx + 1]
                
        # Default to parent directory
        return parts[-2] if len(parts) > 1 else "main"
    
    async def _call_llm(self, template: str, context: Any, pack: DocPack) -> str:
        """Call LLM Gateway to generate documentation"""
        
        # Format context
        if isinstance(context, dict):
            context_str = json.dumps(context, indent=2)[:8000]
        else:
            context_str = str(context)[:8000]
            
        prompt = template.format(context=context_str)
        
        messages = [
            {"role": "system", "content": "You are a technical documentation expert. Generate comprehensive, accurate documentation based on the provided code context."},
            {"role": "user", "content": prompt}
        ]
        
        async with aiohttp.ClientSession() as session:
            payload = {
                "modelKey": self.model_key,
                "messages": messages,
                "temperature": 0.3,
                "max_tokens": 4000,
                "stream": False
            }
            
            async with session.post(
                f"{LLM_GATEWAY_URL}/v1/chat",
                json=payload
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"LLM Gateway error: {error_text}")
                    return f"# Documentation Generation Failed\n\nError: {error_text}"
                    
                result = await resp.json()
                return result.get("content", "# No content generated")

# ============= Stage 4: Verifier =============

class DocVerifier:
    """Verify generated documentation quality"""
    
    def __init__(self, docs: Dict[str, str], artifacts: Dict):
        self.docs = docs
        self.artifacts = artifacts
        
    async def verify(self) -> Dict[str, Any]:
        """Run verification checks on generated documentation"""
        results = {
            "checks": [],
            "warnings": [],
            "errors": []
        }
        
        for path, content in self.docs.items():
            # Check for completeness
            if len(content) < 100:
                results["errors"].append(f"{path}: Documentation too short")
                
            # Check for placeholders
            if "[TODO]" in content or "FIXME" in content:
                results["warnings"].append(f"{path}: Contains placeholders")
                
            # Check markdown structure
            if not content.startswith("#"):
                results["warnings"].append(f"{path}: Missing header")
                
            # Verify code references exist
            file_refs = re.findall(r"`([^`]+\.(py|js|ts|go))`", content)
            for ref in file_refs:
                if ref not in self.artifacts.get("files", {}):
                    results["warnings"].append(f"{path}: References non-existent file {ref}")
                    
            results["checks"].append(f"{path}: Verified")
            
        return results

# ============= API Endpoints =============

@app.get("/")
async def root():
    """Serve the web UI"""
    return FileResponse("/app/public/index.html")

@app.get("/api/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy", "service": "llm-documentor"}

@app.get("/api/packs")
async def list_packs():
    """List available documentation packs"""
    return {
        "packs": [
            {
                "name": pack.name,
                "description": pack.description,
                "audience": pack.audience
            }
            for pack in DOC_PACKS.values()
        ]
    }

@app.post("/api/generate")
async def generate_docs(request: DocRequest, background_tasks: BackgroundTasks):
    """Start documentation generation job"""
    
    # Create job
    job_id = hashlib.sha256(f"{request.repo_url}:{datetime.utcnow().isoformat()}".encode()).hexdigest()[:12]
    job = DocJob(
        id=job_id,
        status="pending",
        progress=0,
        message="Initializing",
        repo_url=request.repo_url,
        branch=request.branch,
        packs=request.packs,
        started_at=datetime.utcnow()
    )
    jobs[job_id] = job
    
    # Start background processing
    background_tasks.add_task(process_doc_job, job_id, request)
    
    return {"job_id": job_id, "status": "started"}

@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    """Get job status"""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@app.get("/api/jobs")
async def list_jobs():
    """List all jobs"""
    return {"jobs": list(jobs.values())}

@app.get("/api/output/{job_id}")
async def get_job_output(job_id: str):
    """Download generated documentation"""
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    if job.status != "complete":
        raise HTTPException(status_code=400, detail="Job not complete")
        
    if not job.output_path:
        raise HTTPException(status_code=404, detail="No output available")
        
    return FileResponse(job.output_path, filename=f"docs_{job_id}.tar.gz")

async def process_doc_job(job_id: str, request: DocRequest):
    """Process documentation generation job"""
    job = jobs[job_id]
    
    try:
        # Stage 1: Extract
        job.status = "extracting"
        job.progress = 10
        job.message = "Extracting code artifacts"
        
        extractor = CodeExtractor(request.repo_url, request.branch)
        artifacts = await extractor.extract()
        
        # Stage 2: Normalize
        job.progress = 30
        job.message = "Normalizing and chunking"
        
        normalizer = ChunkNormalizer(artifacts)
        chunks = normalizer.normalize()
        
        # Stage 3: Generate
        job.status = "generating"
        job.progress = 50
        job.message = "Generating documentation"
        
        generator = DocGenerator(chunks, request.model_key)
        
        all_docs = {}
        for pack_name in request.packs:
            if pack_name not in DOC_PACKS:
                continue
                
            pack = DOC_PACKS[pack_name]
            job.message = f"Generating {pack.name} documentation"
            job.progress = 50 + (30 * request.packs.index(pack_name) / len(request.packs))
            
            docs = await generator.generate(pack, job_id)
            all_docs.update(docs)
            
        # Stage 4: Verify
        job.status = "verifying"
        job.progress = 85
        job.message = "Verifying documentation"
        
        verifier = DocVerifier(all_docs, artifacts)
        verification = await verifier.verify()
        
        # Save output
        job.progress = 95
        job.message = "Saving documentation"
        
        output_path = OUTPUT_DIR / job_id
        output_path.mkdir(parents=True, exist_ok=True)
        
        for doc_path, content in all_docs.items():
            file_path = output_path / doc_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            with open(file_path, 'w') as f:
                f.write(content)
                
        # Create tarball
        import tarfile
        tar_path = OUTPUT_DIR / f"{job_id}.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            tar.add(output_path, arcname="docs")
            
        # Update job
        job.status = "complete"
        job.progress = 100
        job.message = "Documentation generated successfully"
        job.completed_at = datetime.utcnow()
        job.output_path = str(tar_path)
        
        logger.info(f"Job {job_id} completed successfully")
        
    except Exception as e:
        logger.error(f"Job {job_id} failed: {e}")
        job.status = "failed"
        job.error = str(e)
        job.message = f"Failed: {str(e)}"
        job.completed_at = datetime.utcnow()

# Mount static files
app.mount("/static", StaticFiles(directory="/app/public"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 3030)))