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
