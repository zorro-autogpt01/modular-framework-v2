from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Optional
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...diagramming.serializers import to_mermaid, to_plantuml

router = APIRouter(prefix="/repositories", tags=["Graphs"], dependencies=[Depends(authorize)])


@router.get("/{repo_id}/graphs")
def get_graph(
    request: Request,
    repo_id: str,
    type: str = "dependency",  # dependency | module | class | call
    format: str = "json",       # json | mermaid | plantuml
    node_filter: Optional[str] = None,
    depth: int = 0
):
    """
    Return serialized graphs in machine-readable or diagram text formats.
    - type: dependency (file import graph), module (module deps), class (class relations), call (function calls)
    - format: json | mermaid | plantuml
    - node_filter: optional node id to include neighborhood around (only for dependency graph when format=json)
    - depth: for neighborhood filtering (>=1)
    """
    indexer = request.app.state.indexer

    # Build graph payload depending on type
    if type == "dependency":
        dep = indexer.graphs.get(repo_id)
        if not dep or not getattr(dep, "graph", None):
            raise HTTPException(status_code=404, detail="Dependency graph not found")

        if node_filter and depth and depth > 0:
            deps = dep.dependencies_of(node_filter, depth=depth, direction="both")
            imports = set(deps.get("imports", []))
            imported_by = set(deps.get("imported_by", []))
            nodes = [{"id": node_filter, "label": node_filter.split("/")[-1], "type": "target"}]
            for f in sorted(imports):
                nodes.append({"id": f, "label": f.split("/")[-1], "type": "import"})
            for f in sorted(imported_by):
                nodes.append({"id": f, "label": f.split("/")[-1], "type": "imported_by"})
            edges = []
            for f in imports:
                edges.append({"source": node_filter, "target": f, "type": "imports"})
            for f in imported_by:
                edges.append({"source": f, "target": node_filter, "type": "imported_by"})
            graph_payload = {"nodes": nodes, "edges": edges}
        else:
            # Full node/edge listing (may be large)
            try:
                nodes = [{"id": n, "label": str(n).split("/")[-1], "type": "file"} for n in dep.graph.nodes()]
                edges = [{"source": str(u), "target": str(v), "type": "imports"} for (u, v) in dep.graph.edges()]
            except Exception:
                nodes, edges = [], []
            graph_payload = {"nodes": nodes, "edges": edges}

    elif type == "module":
        mg = indexer.module_graphs.get(repo_id)
        if mg is None:
            raise HTTPException(status_code=404, detail="Module graph not found")
        graph_payload = mg

    elif type == "class":
        cg = indexer.class_graphs.get(repo_id)
        if cg is None:
            raise HTTPException(status_code=404, detail="Class graph not found")
        graph_payload = cg

    elif type == "call":
        callg = indexer.call_graphs.get(repo_id)
        if callg is None:
            raise HTTPException(status_code=404, detail="Call graph not found")
        graph_payload = callg

    else:
        raise HTTPException(status_code=400, detail="Unknown graph type")

    # Format
    if format == "json":
        return success_response(request, {"type": type, "graph": graph_payload})
    elif format == "mermaid":
        kind = "class" if type == "class" else ("call" if type == "call" else "module")
        if type == "dependency":
            kind = "dependency"
        text = to_mermaid(graph_payload, kind=kind)
        return success_response(request, {"type": type, "format": "mermaid", "graph_text": text})
    elif format == "plantuml":
        kind = "class" if type == "class" else ("call" if type == "call" else "module")
        if type == "dependency":
            kind = "dependency"
        text = to_plantuml(graph_payload, kind=kind)
        return success_response(request, {"type": type, "format": "plantuml", "graph_text": text})
    else:
        raise HTTPException(status_code=400, detail="Unknown format")
