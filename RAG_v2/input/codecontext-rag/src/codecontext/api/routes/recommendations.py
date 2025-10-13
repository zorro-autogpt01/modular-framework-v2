from fastapi import APIRouter, Depends, Request, Response
from typing import List
import uuid
from ...utils.responses import success_response
from ...api.dependencies import authorize
from ...api.schemas.request import RecommendationRequest, FeedbackRequest, RefineRequest

router = APIRouter(prefix="", tags=["Recommendations"], dependencies=[Depends(authorize)])


@router.post("/recommendations")
def get_recommendations(request: Request, body: RecommendationRequest, response: Response):
    # Generate a session id tied to this request
    session_id = str(uuid.uuid4())
    request.state.request_id = session_id

    # Stubbed recommendations (replace with real pipeline later)
    fake_files = [
        {
            "file_path": "src/auth/login.py",
            "confidence": 87,
            "reasons": [
                {"type": "semantic", "score": 0.45, "explanation": "Similar auth logic"},
                {"type": "dependency", "score": 0.25, "explanation": "Central in imports"},
            ],
            "metadata": {"language": "python", "lines_of_code": 234},
            "dependencies": {"imports": ["src/models/user.py"], "imported_by": ["src/api/routes/auth.py"]},
        },
        {
            "file_path": "src/models/user.py",
            "confidence": 81,
            "reasons": [
                {"type": "semantic", "score": 0.35, "explanation": "User entity referenced"},
                {"type": "history", "score": 0.30, "explanation": "Co-modified with auth"},
            ],
            "metadata": {"language": "python", "lines_of_code": 198},
        },
    ][: body.max_results or 10]

    data = {
        "session_id": session_id,
        "query": body.query,
        "recommendations": fake_files,
        "summary": {
            "total_files": len(fake_files),
            "avg_confidence": sum(f["confidence"] for f in fake_files) / max(1, len(fake_files)),
            "languages": {"python": len(fake_files)},
        },
    }
    return success_response(request, data, response)


@router.post("/recommendations/{session_id}/feedback")
def submit_feedback(request: Request, session_id: str, body: FeedbackRequest):
    # In a real system, persist feedback and update models/weights
    data = {"recorded": True, "message": "Thank you for your feedback! This helps improve recommendations."}
    return success_response(request, data)


@router.post("/recommendations/refine")
def refine_recommendations(request: Request, body: RefineRequest):
    # Stub refinement result, in reality we'd re-query using constraints/examples
    refined = [
        {
            "file_path": "src/auth/login.py",
            "confidence": 90,
            "reasons": [
                {"type": "semantic", "score": 0.5, "explanation": "Matches refined context"},
                {"type": "dependency", "score": 0.3, "explanation": "Auth subsystem"},
            ],
            "metadata": {"language": "python"},
        }
    ]
    data = {
        "session_id": body.session_id,
        "query": "refined",
        "recommendations": refined,
        "summary": {"total_files": len(refined), "avg_confidence": 90.0, "languages": {"python": 1}},
    }
    return success_response(request, data)
