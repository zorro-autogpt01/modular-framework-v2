from pydantic import BaseModel
from typing import List, Optional, Any, Dict


class Reason(BaseModel):
    type: str
    score: float
    explanation: str


class FileRecommendation(BaseModel):
    file_path: str
    confidence: int
    reasons: List[Reason]
    metadata: Optional[Dict[str, Any]] = None
    dependencies: Optional[Dict[str, List[str]]] = None


class RecommendationData(BaseModel):
    session_id: str
    query: str
    recommendations: List[FileRecommendation]
    summary: Optional[Dict[str, Any]] = None


class ContextChunk(BaseModel):
    file_path: str
    start_line: int
    end_line: int
    language: str
    snippet: str
    confidence: int
    reasons: List[Reason]
    distance: Optional[float] = None


class ContextResponse(BaseModel):
    query: str
    chunks: List[ContextChunk]
    summary: Optional[Dict[str, Any]] = None


class PromptMessage(BaseModel):
    role: str
    content: str
    meta: Optional[Dict[str, Any]] = None


class SelectedChunk(BaseModel):
    id: str
    file_path: str
    start_line: int
    end_line: int
    language: str
    confidence: int
    reasons: Optional[List[Reason]] = None


class PromptResponse(BaseModel):
    query: str
    model: Optional[str] = None
    messages: List[PromptMessage]
    selected_chunks: List[SelectedChunk]
    token_usage: Dict[str, Any]
    summary: Optional[Dict[str, Any]] = None


class PatchResponse(BaseModel):
    model: Optional[str] = None
    messages_used: int
    patch: Optional[str] = None
    dry_run: bool = False
    validation: Dict[str, Any]
    summary: Optional[Dict[str, Any]] = None


class ApplyPatchResponse(BaseModel):
    base_branch: str
    new_branch: Optional[str] = None
    commit: Optional[str] = None
    pushed: bool = False
    pr_created: bool = False
    pr: Optional[Dict[str, Any]] = None
    validation: Dict[str, Any]
    logs: List[str] = []
    summary: Optional[Dict[str, Any]] = None
