import json
import os
import subprocess
import tempfile
from typing import Dict, List


def run_pyreverse(repo_path: str) -> Dict:
    """
    Run pyreverse to get class and package/module relations.
    Returns normalized dict:
    {
      "class_graph": {"nodes": [...], "edges": [...]},
      "module_graph": {"nodes": [...], "edges": [...]}
    }
    Best-effort: returns empty graphs on failure.
    """
    class_graph = {"nodes": [], "edges": []}
    module_graph = {"nodes": [], "edges": []}

    try:
        with tempfile.TemporaryDirectory() as tmp:
            # Attempt to run pyreverse output as JSON into tmp
            cmd = ["pyreverse", "-o", "json", "-p", "project", repo_path, "-d", tmp]
            proc = subprocess.run(cmd, cwd=repo_path, capture_output=True, text=True, timeout=120)
            if proc.returncode != 0:
                # Fallback try without -d (older versions write in cwd)
                proc2 = subprocess.run(["pyreverse", "-o", "json", "-p", "project", repo_path], cwd=repo_path, capture_output=True, text=True, timeout=120)
                if proc2.returncode != 0:
                    return {"class_graph": class_graph, "module_graph": module_graph}
                out_dir = repo_path
            else:
                out_dir = tmp

            # Look for produced json files
            json_files = [os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.endswith(".json")]
            classes_json = None
            packages_json = None
            for f in json_files:
                base = os.path.basename(f)
                if "classes" in base:
                    classes_json = f
                if "packages" in base or "modules" in base:
                    packages_json = f

            # Parse class relationships
            if classes_json and os.path.exists(classes_json):
                try:
                    with open(classes_json, "r", encoding="utf-8") as cf:
                        data = json.load(cf)
                    # Expect data like {"objects": [{"name": "A", "bases": ["B"], "module": "m"}, ...]}
                    objects = data.get("objects") or data.get("classes") or []
                    id_map: Dict[str, str] = {}
                    for o in objects:
                        cid = f'{o.get("module","")}.{o.get("name","")}'.strip(".")
                        label = o.get("name") or cid
                        id_map[label] = cid
                        class_graph["nodes"].append({"id": cid, "label": label, "type": "class"})
                        # Inheritance edges
                        bases = o.get("bases") or o.get("parents") or []
                        for b in bases:
                            bid = f'{o.get("module","")}.{b}'.strip(".")
                            class_graph["edges"].append({"source": bid, "target": cid, "type": "inherits"})
                except Exception:
                    pass

            # Parse package/module dependencies
            if packages_json and os.path.exists(packages_json):
                try:
                    with open(packages_json, "r", encoding="utf-8") as pf:
                        pdata = json.load(pf)
                    pkgs = pdata.get("packages") or pdata.get("modules") or []
                    for p in pkgs:
                        name = p.get("name") or p.get("module") or ""
                        if not name:
                            continue
                        module_graph["nodes"].append({"id": name, "label": name, "type": "module"})
                        # dependencies may be "depends": ["x","y"]
                        deps = p.get("depends") or p.get("dependencies") or []
                        for d in deps:
                            module_graph["edges"].append({"source": name, "target": d, "type": "module_dep"})
                except Exception:
                    pass
    except Exception:
        # Return empty on any failure
        return {"class_graph": class_graph, "module_graph": module_graph}

    return {"class_graph": class_graph, "module_graph": module_graph}