from typing import Dict, List


def _ensure_ids(graph: Dict) -> Dict:
    graph = graph or {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    # Guarantee id fields
    for n in nodes:
        n.setdefault("id", n.get("label") or n.get("name"))
    return {"nodes": nodes, "edges": edges}


def to_mermaid(graph: Dict, kind: str = "module") -> str:
    """
    Render a normalized graph to Mermaid text.
    - kind: "class" -> classDiagram; "module" -> flowchart LR; "call" -> flowchart LR; "dependency" -> flowchart LR
    """
    g = _ensure_ids(graph)
    nodes: List[Dict] = g["nodes"]
    edges: List[Dict] = g["edges"]

    def safe(s: str) -> str:
        return (s or "").replace('"', '\\"')

    if kind == "class":
        out = ["classDiagram"]
        # classes
        for n in nodes:
            if n.get("type") in ("class", None):
                out.append(f'class "{safe(n.get("label") or n["id"])}" as {n["id"]}')
        # relations
        for e in edges:
            src = e.get("source")
            tgt = e.get("target")
            et = e.get("type", "")
            if et in ("inherits", "generalization", "extends"):
                out.append(f"{src} <|-- {tgt}")
            elif et in ("association", "uses", "aggregates"):
                out.append(f"{src} --> {tgt}")
            else:
                out.append(f"{src} ..> {tgt}")
        return "\n".join(out)

    # For module/call/dependency use flowchart LR
    out = ["flowchart LR"]
    for n in nodes:
        label = safe(n.get("label") or n.get("id"))
        out.append(f'{n["id"]}["{label}"]')
    for e in edges:
        src = e.get("source")
        tgt = e.get("target")
        et = e.get("type", "")
        arrow = "-->"
        if kind == "call" or et == "calls":
            arrow = "==>"
        out.append(f"{src} {arrow} {tgt}")
    return "\n".join(out)


def to_plantuml(graph: Dict, kind: str = "module") -> str:
    """
    Render a normalized graph to PlantUML text.
    """
    g = _ensure_ids(graph)
    nodes: List[Dict] = g["nodes"]
    edges: List[Dict] = g["edges"]

    def safe(s: str) -> str:
        return (s or "").replace('"', '\\"')

    lines: List[str] = ["@startuml"]
    if kind == "class":
        for n in nodes:
            label = safe(n.get("label") or n["id"])
            lines.append(f'class "{label}" as {n["id"]}')
        for e in edges:
            src, tgt = e.get("source"), e.get("target")
            et = e.get("type", "")
            if et in ("inherits", "extends", "generalization"):
                lines.append(f"{src} <|-- {tgt}")
            elif et in ("association", "uses", "aggregates"):
                lines.append(f"{src} --> {tgt}")
            else:
                lines.append(f"{src} ..> {tgt}")
    else:
        for n in nodes:
            label = safe(n.get("label") or n["id"])
            lines.append(f'component "{label}" as {n["id"]}')
        for e in edges:
            src, tgt = e.get("source"), e.get("target")
            et = e.get("type", "")
            arrow = "-->"
            if kind == "call" or et == "calls":
                arrow = "==>"
            lines.append(f"{src} {arrow} {tgt}")
    lines.append("@enduml")
    return "\n".join(lines)