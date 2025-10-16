import sys
import os
import runpy
from types import FrameType
from typing import Dict, Set, Tuple, Optional

def _qualname(frame: FrameType) -> str:
    code = frame.f_code
    mod = frame.f_globals.get("__name__", "")
    func = code.co_name
    if mod is None:
        mod = ""
    return f"{mod}.{func}"

class CallTracer:
    def __init__(self):
        self.edges: Dict[Tuple[str, str], int] = {}
        self.enabled = False

    def _tracer(self, frame: FrameType, event: str, arg):
        if event == "call":
            caller = _qualname(frame.f_back) if frame and frame.f_back else None
            callee = _qualname(frame)
            if caller and callee:
                key = (caller, callee)
                self.edges[key] = self.edges.get(key, 0) + 1
        return self._tracer

    def start(self):
        if self.enabled:
            return
        self.enabled = True
        sys.setprofile(self._tracer)

    def stop(self):
        if not self.enabled:
            return
        sys.setprofile(None)
        self.enabled = False

def trace_entrypoint(repo_path: str, module: Optional[str] = None, script: Optional[str] = None, argv: Optional[list] = None) -> Dict:
    """
    Execute a Python module or script under profiler and return call edges with weights.
    """
    old_cwd = os.getcwd()
    old_path = list(sys.path)
    try:
        os.chdir(repo_path)
        if repo_path not in sys.path:
            sys.path.insert(0, repo_path)
        if argv is not None:
            sys.argv = [module or script or "entry"] + argv
        tracer = CallTracer()
        tracer.start()
        if module:
            runpy.run_module(module, run_name="__main__", alter_sys=True)
        elif script:
            runpy.run_path(script, run_name="__main__")
        else:
            # Nothing to run
            pass
    finally:
        tracer.stop()
        os.chdir(old_cwd)
        sys.path = old_path

    edges = [{"source": s, "target": t, "type": "calls", "weight": w} for ((s, t), w) in tracer.edges.items()]
    # Nodes are function names
    nodes: Set[str] = set()
    for e in edges:
        nodes.add(e["source"])
        nodes.add(e["target"])
    return {"nodes": [{"id": n, "label": n, "type": "function"} for n in sorted(nodes)], "edges": edges}