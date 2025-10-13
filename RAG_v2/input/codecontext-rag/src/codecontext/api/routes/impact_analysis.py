from fastapi import APIRouter, Depends, Request
from ...api.dependencies import authorize
from ...api.schemas.request import ImpactAnalysisRequest

from ...api.schemas.request import ImpactAnalysisRequest

from ...utils.responses import success_response

router = APIRouter(prefix="", tags=["Impact Analysis"], dependencies=[Depends(authorize)])


@router.post("/impact-analysis")
def analyze_impact(request: Request, body: ImpactAnalysisRequest):
    modified = body.modified_files or []
    affected = [
        {"file_path": "src/api/routes/users.py", "impact_type": "direct", "distance": 1, "confidence": 85},
        {"file_path": "tests/test_user_model.py", "impact_type": "historical", "distance": 2, "confidence": 60},
    ]
    data = {
        "modified_files": modified,
        "impact": {
            "risk_level": "medium",
            "affected_files": affected,
            "test_files": ["tests/test_user_model.py"],
            "recommendations": [
                "Run all tests in tests/api/",
                "Review changes with the authentication team",
            ],
            "statistics": {"total_affected": len(affected), "direct_dependencies": 1, "transitive_dependencies": 1},
        },
    }
    return success_response(request, data)
