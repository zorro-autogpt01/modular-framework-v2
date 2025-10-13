from fastapi import APIRouter, Depends, Request
from ...api.dependencies import authorize
from ...utils.responses import success_response

router = APIRouter(prefix="", tags=["Dependencies"], dependencies=[Depends(authorize)])


@router.get("/dependencies/{file_path}")
def get_file_dependencies(request: Request, file_path: str, repository_id: str, depth: int = 2, direction: str = "both", format: str = "json"):
    nodes = [
        {"id": file_path, "label": file_path.split("/")[-1], "type": "target", "metadata": {}},
        {"id": "src/models/user.py", "label": "user.py", "type": "import", "metadata": {}},
        {"id": "src/api/routes/auth.py", "label": "auth.py", "type": "imported_by", "metadata": {}},
    ]
    edges = [
        {"source": file_path, "target": "src/models/user.py", "type": "imports"},
        {"source": "src/api/routes/auth.py", "target": file_path, "type": "imported_by"},
    ]
    data = {
        "file_path": file_path,
        "graph": {"nodes": nodes, "edges": edges},
        "statistics": {"total_dependencies": 2, "depth": depth, "circular_dependencies": []},
    }
    return success_response(request, data)
