from fastapi import APIRouter, Depends, HTTPException, Request
from ...api.dependencies import authorize
from ...utils.responses import success_response

router = APIRouter(prefix="/repositories", tags=["Diagnostics"], dependencies=[Depends(authorize)])

def _graph_counts(graph_obj):
    if not graph_obj or not getattr(graph_obj, "graph", None):
        return {"nodes": 0, "edges": 0, "present": False}
    try:
        g = graph_obj.graph
        return {"nodes": g.number_of_nodes(), "edges": g.number_of_edges(), "present": True}
    except Exception:
        return {"nodes": 0, "edges": 0, "present": False}

@router.get("/{repo_id}/graphs/summary")
def graphs_summary(request: Request, repo_id: str):
    indexer = request.app.state.indexer

    dep = indexer.graphs.get(repo_id)
    cg = indexer.class_graphs.get(repo_id)
    mg = indexer.module_graphs.get(repo_id)
    callg = indexer.call_graphs.get(repo_id)

    summary = {
        "repo_id": repo_id,
        "dependency": _graph_counts(dep),
        "class": {"nodes": len((cg or {}).get("nodes", [])), "edges": len((cg or {}).get("edges", [])), "present": bool(cg)},
        "module": {"nodes": len((mg or {}).get("nodes", [])), "edges": len((mg or {}).get("edges", [])), "present": bool(mg)},
        "call": {"nodes": len((callg or {}).get("nodes", [])), "edges": len((callg or {}).get("edges", [])), "present": bool(callg)},
        "metadata_path": str(indexer._meta_file(repo_id)),
        "has_metadata_file": indexer._meta_file(repo_id).exists(),
    }
    return success_response(request, summary)

@router.post("/{repo_id}/graphs/reload")
def graphs_reload(request: Request, repo_id: str):
    indexer = request.app.state.indexer
    ok = indexer.load_metadata_for_repo(repo_id)
    if not ok:
        raise HTTPException(status_code=404, detail="No metadata found for repo (reload failed)")
    return graphs_summary(request, repo_id)