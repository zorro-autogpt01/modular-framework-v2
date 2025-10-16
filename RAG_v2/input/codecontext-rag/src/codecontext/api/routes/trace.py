from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Optional
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...api.schemas.request import TracePythonRequest
from ...runtime.pytrace import trace_entrypoint

router = APIRouter(prefix="/repositories", tags=["Tracing"], dependencies=[Depends(authorize)])

@router.post("/{repo_id}/trace/python")
async def trace_python(
    request: Request,
    repo_id: str,
    body: TracePythonRequest
):
    """
    Run a Python module or script under a profiler to capture a dynamic call graph.
    Merge results into the in-memory call_graph (increment weights).
    """
    repo_store = request.app.state.repo_store
    indexer = request.app.state.indexer

    repo = repo_store.get(repo_id)
    if not repo or not repo.get("local_path"):
        raise HTTPException(status_code=404, detail="Repository not found or missing local_path")

    repo_path = repo["local_path"]
    try:
        cg = trace_entrypoint(repo_path, module=body.entry_module, script=body.entry_script, argv=body.argv or [])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trace failed: {e}")

    # Merge into indexer.call_graphs weights
    existing = indexer.call_graphs.get(repo_id) or {"nodes": [], "edges": []}
    node_ids = {n["id"] for n in existing.get("nodes", [])}
    for n in cg.get("nodes", []):
        if n["id"] not in node_ids:
            existing["nodes"].append(n)
            node_ids.add(n["id"])

    # Merge edges with weight accumulation
    key_to_edge = {}
    for e in existing.get("edges", []):
        key_to_edge[(e.get("source"), e.get("target"))] = e
    for e in cg.get("edges", []):
        k = (e.get("source"), e.get("target"))
        if k in key_to_edge:
            key_to_edge[k]["weight"] = (key_to_edge[k].get("weight") or 0) + (e.get("weight") or 1)
        else:
            existing["edges"].append(e)

    indexer.call_graphs[repo_id] = existing
    return success_response(request, {"message": "trace merged", "nodes": len(existing["nodes"]), "edges": len(existing["edges"])})