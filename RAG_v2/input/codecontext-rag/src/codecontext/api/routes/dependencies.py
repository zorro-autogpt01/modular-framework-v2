from fastapi import APIRouter, Depends, Request, HTTPException
from ...api.dependencies import authorize
from ...utils.responses import success_response
from ...diagramming.serializers import to_mermaid, to_plantuml

router = APIRouter(prefix="", tags=["Dependencies"], dependencies=[Depends(authorize)])


@router.get("/dependencies/{file_path}")
def get_file_dependencies(
    request: Request,
    file_path: str,
    repository_id: str,
    depth: int = 2,
    direction: str = "both",
    format: str = "json"
):
    indexer = request.app.state.indexer
    dep_graph = indexer.graphs.get(repository_id)

    # Lazy-load metadata if not present in memory
    if not dep_graph:
        try:
            if indexer.load_metadata_for_repo(repository_id):
                dep_graph = indexer.graphs.get(repository_id)
        except Exception:
            dep_graph = None

    if not dep_graph or not getattr(dep_graph, "graph", None):
        raise HTTPException(
            status_code=404,
            detail="Dependency graph not available for this repository. Please reindex the repository."
        )

    # Decode URL-encoded path if needed (FastAPI path already decoded)
    target = file_path

    # Get neighbors
    deps = dep_graph.dependencies_of(target, depth=depth, direction=direction)
    imports = set(deps.get("imports", []))
    imported_by = set(deps.get("imported_by", []))

    # Build nodes
    nodes = []
    seen = set()

    def add_node(fid: str, ntype: str):
        if fid in seen:
            return
        seen.add(fid)
        nodes.append({
            "id": fid,
            "label": fid.split("/")[-1],
            "type": ntype,
            "metadata": {}
        })

    add_node(target, "target")
    for f in sorted(imports):
        add_node(f, "import")
    for f in sorted(imported_by):
        add_node(f, "imported_by")

    # Build edges
    edges = []
    if direction in ("imports", "both"):
        for f in imports:
            edges.append({"source": target, "target": f, "type": "imports"})
    if direction in ("imported_by", "both"):
        for f in imported_by:
            edges.append({"source": f, "target": target, "type": "imported_by"})

    # Stats
    try:
        cycles = dep_graph.find_circular_dependencies()
    except Exception:
        cycles = []

    graph_payload = {"nodes": nodes, "edges": edges}

    if format == "mermaid":
        text = to_mermaid(graph_payload, kind="dependency")
        data = {
            "file_path": target,
            "graph_text": text,
            "format": "mermaid",
            "statistics": {
                "total_dependencies": len(imports) + len(imported_by),
                "depth": depth,
                "circular_dependencies": cycles[:10]
            },
        }
        return success_response(request, data)

    if format == "plantuml":
        text = to_plantuml(graph_payload, kind="dependency")
        data = {
            "file_path": target,
            "graph_text": text,
            "format": "plantuml",
            "statistics": {
                "total_dependencies": len(imports) + len(imported_by),
                "depth": depth,
                "circular_dependencies": cycles[:10]
            },
        }
        return success_response(request, data)

    # Default JSON
    data = {
        "file_path": target,
        "graph": graph_payload,
        "statistics": {
            "total_dependencies": len(imports) + len(imported_by),
            "depth": depth,
            "circular_dependencies": cycles[:10]
        },
    }
    return success_response(request, data)
