import json
import os
import subprocess
from typing import Dict


def run_depcruise(repo_path: str, src_dir: str | None = None) -> Dict:
    """
    Run dependency-cruiser for JS/TS module dependency graph.
    Returns normalized {"nodes": [...], "edges": [...]}
    """
    base = src_dir or "src"
    target_dir = base if os.path.isdir(os.path.join(repo_path, base)) else "."
    try:
        # Use npx; dependency-cruiser must be available in PATH or project dev deps
        cmd = ["npx", "--yes", "dependency-cruiser", "-f", "json", target_dir]
        proc = subprocess.run(cmd, cwd=repo_path, capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            # Return empty if not available
            return {"nodes": [], "edges": []}
        data = json.loads(proc.stdout or "{}")
        modules = data.get("modules") or []
        nodes = []
        edges = []
        seen = set()
        for m in modules:
            src = m.get("source")
            if not src:
                continue
            if src not in seen:
                nodes.append({"id": src, "label": os.path.basename(src), "type": "module"})
                seen.add(src)
            for dep in m.get("dependencies", []):
                resolved = dep.get("resolved") or dep.get("to")
                if not resolved:
                    continue
                if resolved not in seen:
                    nodes.append({"id": resolved, "label": os.path.basename(resolved), "type": "module"})
                    seen.add(resolved)
                edges.append({"source": src, "target": resolved, "type": "module_dep"})
        return {"nodes": nodes, "edges": edges}
    except Exception:
        return {"nodes": [], "edges": []}