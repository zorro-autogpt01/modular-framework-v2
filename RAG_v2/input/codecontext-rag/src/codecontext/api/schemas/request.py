from pydantic import BaseModel, Field
from typing import Optional, List, Dict


class RegisterRepositoryRequest(BaseModel):
    name: str
    source_type: str  # "local", "git", "github_hub"
    
    # For local/git
    source_path: Optional[str] = None
    source_url: Optional[str] = None
    branch: Optional[str] = "main"
    
    # For GitHub Hub integration
    github_conn_id: Optional[str] = None
    github_branch: Optional[str] = None
    
    languages: Optional[List[str]] = None
    config: Optional[Dict] = None


class IndexOptions(BaseModel):
    analyze_git_history: Optional[bool] = True
    chunk_size: Optional[int] = 512
    parallel_workers: Optional[int] = 4


class IndexRequest(BaseModel):
    mode: str = Field(pattern=r"^(full|incremental)$")
    options: Optional[IndexOptions] = None


class RecommendationFilters(BaseModel):
    file_patterns: Optional[Dict[str, List[str]]] = None
    directories: Optional[Dict[str, List[str]]] = None
    languages: Optional[List[str]] = None


class RecommendationOptions(BaseModel):
    include_tests: Optional[bool] = False
    analyze_dependencies: Optional[bool] = True
    dependency_depth: Optional[int] = 1
    include_callers: Optional[bool] = False
    include_callees: Optional[bool] = False
    min_confidence: Optional[int] = 50


class RecommendationRequest(BaseModel):
    repository_id: str
    query: str
    max_results: Optional[int] = 10
    filters: Optional[RecommendationFilters] = None
    options: Optional[RecommendationOptions] = None


class FeedbackRequest(BaseModel):
    relevant_files: Optional[List[str]] = None
    irrelevant_files: Optional[List[str]] = None
    missing_files: Optional[List[str]] = None
    comments: Optional[str] = None


class RefineRequest(BaseModel):
    session_id: str
    additional_context: Optional[str] = None
    positive_examples: Optional[List[str]] = None
    negative_examples: Optional[List[str]] = None
    filters: Optional[RecommendationFilters] = None
    max_results: Optional[int] = None


class ImpactAnalysisOptions(BaseModel):
    include_tests: Optional[bool] = True
    include_git_history: Optional[bool] = True


class ImpactAnalysisRequest(BaseModel):
    repository_id: str
    modified_files: List[str]
    analysis_depth: Optional[int] = 2
    options: Optional[ImpactAnalysisOptions] = None


class CodeSearchRequest(BaseModel):
    repository_id: str
    query: str
    search_type: Optional[str] = "semantic"
    max_results: Optional[int] = 10
    filters: Optional[Dict] = None


class ContextRequest(BaseModel):
    query: str
    max_chunks: Optional[int] = 8
    surround_lines: Optional[int] = 0
    expand_neighbors: Optional[bool] = True
    filters: Optional[RecommendationFilters] = None
    # Retrieval options
    retrieval_mode: Optional[str] = "vector"  # "vector" | "callgraph" | "slice"
    call_graph_depth: Optional[int] = 2
    # Program slicing
    slice_target: Optional[str] = None        # function name or token
    slice_direction: Optional[str] = "forward"  # forward | backward
    slice_depth: Optional[int] = 2


class PromptOptions(BaseModel):
    # LLM/prompt controls
    model: Optional[str] = None
    temperature: Optional[float] = 0.2
    max_tokens: Optional[int] = 2200
    system_prompt: Optional[str] = None

    # Retrieval/expansion controls
    max_chunks: Optional[int] = 12
    per_file_neighbor_chunks: Optional[int] = 2
    include_dependency_expansion: Optional[bool] = True
    dependency_depth: Optional[int] = 1
    dependency_direction: Optional[str] = "both"
    neighbor_files_limit: Optional[int] = 4

    # Hybrid ranking controls
    hybrid_alpha: Optional[float] = 0.2

    # Filters
    languages: Optional[List[str]] = None

    # Retrieval modes
    retrieval_mode: Optional[str] = "vector"  # "vector" | "callgraph" | "slice"
    call_graph_depth: Optional[int] = 2

    # Program slicing
    slice_target: Optional[str] = None
    slice_direction: Optional[str] = "forward"
    slice_depth: Optional[int] = 2


class PromptRequest(BaseModel):
    query: str
    options: Optional[PromptOptions] = None
    filters: Optional[RecommendationFilters] = None


class PromptMessage(BaseModel):
    role: str
    content: str


class GeneratePatchRequest(BaseModel):
    # Either provide prompt_messages (from /prompt), or query+options to build internally.
    prompt_messages: Optional[List[PromptMessage]] = None
    query: Optional[str] = None
    options: Optional[PromptOptions] = None
    filters: Optional[RecommendationFilters] = None

    # LLM controls
    model: Optional[str] = None
    temperature: Optional[float] = 0.2
    max_output_tokens: Optional[float] = 1400
    stream: Optional[bool] = False
    dry_run: Optional[bool] = False

    # Safety / restrictions
    restrict_to_files: Optional[List[str]] = None
    enforce_restriction: Optional[bool] = True

    # If set, include a high-level instruction to output ONLY a unified diff without commentary
    force_unified_diff: Optional[bool] = True


class ApplyPatchRequest(BaseModel):
    patch: str
    base_branch: Optional[str] = None
    new_branch: Optional[str] = None
    commit_message: Optional[str] = None
    push: Optional[bool] = False
    create_pr: Optional[bool] = False
    pr_title: Optional[str] = None
    pr_body: Optional[str] = None
    draft_pr: Optional[bool] = False
    dry_run: Optional[bool] = False

    # Safety / restrictions
    restrict_to_files: Optional[List[str]] = None
    enforce_restriction: Optional[bool] = True

    # Hooks
    skip_hooks: Optional[bool] = False

class TracePythonRequest(BaseModel):
    entry_module: Optional[str] = None  # ex: "app.main"
    entry_script: Optional[str] = None  # ex: "scripts/run.py"
    argv: Optional[List[str]] = None
