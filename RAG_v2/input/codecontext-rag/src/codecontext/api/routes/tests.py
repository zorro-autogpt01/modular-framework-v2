from fastapi import APIRouter, Depends, HTTPException, Request
from typing import List, Dict, Any
import subprocess
import os

from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...config import settings

router = APIRouter(prefix="/repositories", tags=["Tests"], dependencies=[Depends(authorize)])

def _rank_tests(indexer, repo_id: str, modified_files: List[str]) -> List[Dict[str, Any]]:
    """
    Rank tests based on dependency graph (imported_by closure) and filenames.
    """
    dep = indexer.graphs.get(repo_id)
    if not dep or not getattr(dep, "graph", None):
        return []
    # gather test candidates (nodes starting with tests/ or ending with _test.py)
    nodes = list(dep.graph.nodes())
    test_nodes = [n for n in nodes if str(n).startswith("tests/") or str(n).endswith("_test.py") or "/test_" in str(n)]
    # score by distance to modified files (imported_by path length)
    scores = {}
    for t in test_nodes:
        scores[t] = 0.0
    for mf in modified_files:
        try:
            deps = dep.dependencies_of(mf, depth=3, direction="imported_by")
            impacted = set(deps.get("imported_by") or [])
            for t in test_nodes:
                if t in impacted:
                    scores[t] = max(scores[t], 1.0)
        except Exception:
            pass
    ranked = sorted([{"test": t, "score": s} for t, s in scores.items()], key=lambda x: x["score"], reverse=True)
    return ranked

@router.post("/{repo_id}/tests/select")
def select_tests(request: Request, repo_id: str, body: Dict[str, Any]):
    """
    Select tests impacted by modified files or query.
    Body: {"modified_files": [...]} or {"query": "..."}.
    """
    indexer = request.app.state.indexer
    modified_files = body.get("modified_files") or []
    if not modified_files and body.get("query"):
        # fallback: try to find file by simple contains
        q = body["query"].lower()
        g = indexer.graphs.get(repo_id)
        if g and getattr(g, "graph", None):
            modified_files = [n for n in g.graph.nodes() if q in str(n).lower()][:3]
    ranked = _rank_tests(indexer, repo_id, modified_files)
    return success_response(request, {"modified_files": modified_files, "ranked_tests": ranked})

@router.post("/{repo_id}/tests/run")
def run_tests(request: Request, repo_id: str, body: Dict[str, Any]):
    """
    Run tests in the repository worktree.
    Body: {"tests": ["tests/test_x.py", ...]} optional.
    Runs TEST_CMD environment (default pytest -q). If tests provided, passes -k pattern or files directly.
    """
    repo_store = request.app.state.repo_store
    repo = repo_store.get(repo_id)
    if not repo or not repo.get("local_path"):
        raise HTTPException(status_code=404, detail="Repository not found")
    repo_path = repo["local_path"]

    tests = body.get("tests") or []
    cmd = settings.test_cmd
    # If pytest and explicit tests, pass them as args
    args = cmd.split()
    if "pytest" in args[0] and tests:
        args = args + tests
    # Execute
    try:
        p = subprocess.run(args, cwd=repo_path, capture_output=True, text=True, timeout=1200)
        ok = (p.returncode == 0)
        out = (p.stdout or "") + "\n" + (p.stderr or "")
    except Exception as e:
        ok = False; out = f"Failed to run tests: {e}"
    return success_response(request, {"ok": ok, "output": out})