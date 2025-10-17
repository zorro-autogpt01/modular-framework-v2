from fastapi import APIRouter, Depends, Request
from typing import Dict, Any, List
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...core.patch import parse_unified_diff

router = APIRouter(prefix="/repositories", tags=["Patch Segmentation"], dependencies=[Depends(authorize)])

def _classify(file_path: str) -> str:
    fp = file_path.lower()
    if fp.startswith("tests/") or fp.endswith("_test.py") or "/test_" in fp:
        return "tests"
    if fp.endswith(".py") or fp.endswith(".ts") or fp.endswith(".js") or fp.endswith(".java"):
        return "code"
    if fp.endswith(".md") or fp.endswith(".txt"):
        return "docs"
    return "other"

@router.post("/{repo_id}/patch/segment")
def segment_patch(request: Request, repo_id: str, body: Dict[str, Any]):
    """
    Segment a unified diff into commit-sized chunks by category and directory.
    Body: {"patch": "..."}
    """
    patch = body.get("patch") or ""
    files = parse_unified_diff(patch)
    segments: Dict[str, Dict[str, Any]] = {}
    for f in files:
        fp = f.get("file") or ""
        cat = _classify(fp)
        key = f"{cat}:{fp.split('/')[0] if '/' in fp else fp}"
        seg = segments.setdefault(key, {"category": cat, "files": []})
        seg["files"].append(fp)
    # Suggested plan
    plan: List[Dict[str, Any]] = []
    for key, seg in segments.items():
        msg = f"{seg['category']}: update {len(seg['files'])} file(s)"
        plan.append({"message": msg, "files": seg["files"]})
    return success_response(request, {"segments": list(segments.values()), "commit_plan": plan})