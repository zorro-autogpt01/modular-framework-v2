import os
from typing import Dict
import xml.etree.ElementTree as ET


def run_doxygen(repo_path: str) -> Dict:
    """
    Best-effort parser for Doxygen XML output in repo (assumes docs/xml exists) to produce:
    - call_graph: calls edges between functions
    - class_graph: inheritance edges
    We do not run doxygen here to avoid heavy deps; we only parse if output exists.
    Returns {"call_graph": {"nodes": [], "edges": []}, "class_graph": {"nodes": [], "edges": []}}
    """
    xml_root = None
    # heuristic: docs/xml or doxygen/xml
    for candidate in ("docs/xml", "doxygen/xml", "xml"):
        cand = os.path.join(repo_path, candidate)
        if os.path.isdir(cand):
            xml_root = cand
            break
    if not xml_root:
        return {}

    call_nodes = {}
    call_edges = []
    class_nodes = {}
    class_edges = []

    # Parse compound*.xml files
    for fname in os.listdir(xml_root):
        if not fname.endswith(".xml"):
            continue
        fpath = os.path.join(xml_root, fname)
        try:
            tree = ET.parse(fpath)
            root = tree.getroot()
        except Exception:
            continue

        # Parse functions and calls (very simplified)
        for memberdef in root.findall(".//memberdef"):
            kind = memberdef.attrib.get("kind")
            if kind not in ("function", "method"):
                continue
            name_el = memberdef.find("name")
            if name_el is None:
                continue
            func_name = name_el.text or ""
            if not func_name:
                continue
            func_id = func_name
            if func_id not in call_nodes:
                call_nodes[func_id] = {"id": func_id, "label": func_name, "type": "function"}

            # Doxygen call relations sometimes under "references" elements
            for ref in memberdef.findall(".//references"):
                callee = (ref.text or "").strip()
                if callee:
                    if callee not in call_nodes:
                        call_nodes[callee] = {"id": callee, "label": callee, "type": "function"}
                    call_edges.append({"source": func_id, "target": callee, "type": "calls"})

        # Parse classes and inheritance
        for compound in root.findall(".//compounddef"):
            if compound.attrib.get("kind") not in ("class", "struct"):
                continue
            cname_el = compound.find("compoundname")
            if cname_el is None:
                continue
            cname = cname_el.text or ""
            if cname and cname not in class_nodes:
                class_nodes[cname] = {"id": cname, "label": cname, "type": "class"}
            for base in compound.findall(".//basecompoundref"):
                bname = (base.text or "").strip()
                if bname:
                    if bname not in class_nodes:
                        class_nodes[bname] = {"id": bname, "label": bname, "type": "class"}
                    class_edges.append({"source": bname, "target": cname, "type": "inherits"})

    return {
        "call_graph": {
            "nodes": list(call_nodes.values()),
            "edges": call_edges
        },
        "class_graph": {
            "nodes": list(class_nodes.values()),
            "edges": class_edges
        }
    }