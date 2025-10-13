from fastapi import APIRouter, Depends, Request
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import CodeSearchRequest

router = APIRouter(prefix="", tags=["Recommendations"], dependencies=[Depends(authorize)])


@router.post("/search/code")
def search_code(request: Request, body: CodeSearchRequest):
    # Stubbed results; replace with real vector + hybrid search
    results = [
        {
            "file_path": "src/utils/validators.py",
            "entity_type": "function",
            "entity_name": "validate_email",
            "similarity_score": 0.89,
            "code_snippet": """
def validate_email(email: str) -> bool:
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return re.match(pattern, email) is not None
""".strip(),
            "line_number": 45,
        }
    ][: body.max_results or 10]

    data = {
        "query": body.query,
        "results": results,
        "total_results": len(results),
    }
    return success_response(request, data)
