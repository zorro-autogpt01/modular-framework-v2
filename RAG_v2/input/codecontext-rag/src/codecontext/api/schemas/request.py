from pydantic import BaseModel, Field
from typing import Optional, List, Dict


class RegisterRepositoryRequest(BaseModel):
    name: str
    source_type: str
    source_path: Optional[str] = None
    source_url: Optional[str] = None
    branch: Optional[str] = "main"
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


class CodeSearchRequest(BaseModel):
    repository_id: str
    query: str
    search_type: Optional[str] = "semantic"
    max_results: Optional[int] = 10
    filters: Optional[Dict] = None

    repository_id: str
    modified_files: List[str]
    analysis_depth: Optional[int] = 2
    options: Optional[ImpactAnalysisOptions] = None
