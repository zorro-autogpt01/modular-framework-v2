#!/usr/bin/env python3

# api_code_slicer.py — Corrected and enhanced version
from __future__ import annotations
import argparse, ast, re, sys, os, json, shutil, fnmatch, difflib, logging
from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional, Iterable
from pathlib import Path

try:
    import yaml  # optional, for --rewrite YAML
except Exception:
    yaml = None

DEFAULT_IGNORES = [
    "**/.git/**","**/.hg/**","**/.svn/**",
    "**/.venv/**","**/venv/**","**/env/**","**/__pycache__/**","**/site-packages/**",
    "**/node_modules/**","**/dist/**","**/build/**","**/out/**","**/.next/**","**/.turbo/**",
    "**/.mypy_cache/**","**/.pytest_cache/**","**/.tox/**","**/.idea/**","**/.vscode/**"
]

def setup_logging(verbose: bool = False):
    """Configure logging for the application."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        format='%(asctime)s [%(levelname)s] %(message)s',
        level=level,
        stream=sys.stderr
    )

def read_text(p: Path) -> str:
    """Read text file with fallback encoding support."""
    encodings = ['utf-8', 'utf-8-sig', 'latin-1', 'cp1252']
    for enc in encodings:
        try:
            return p.read_text(encoding=enc)
        except (UnicodeDecodeError, LookupError):
            continue
    # Last resort
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        logging.warning(f"Failed to read {p}: {e}")
        return ""

def ensure_dir(p: Path):
    """Create directory if it doesn't exist."""
    p.mkdir(parents=True, exist_ok=True)

def should_skip(path: Path, ignore_globs: List[str]) -> bool:
    """Check if path should be skipped based on ignore patterns."""
    ps = path.as_posix()
    return any(fnmatch.fnmatch(ps, g) for g in ignore_globs)

def load_slicerignore(repo_root: Path) -> List[str]:
    """Load custom ignore patterns from .slicerignore file."""
    f = repo_root / ".slicerignore"
    if not f.exists(): 
        return []
    return [ln.strip() for ln in read_text(f).splitlines() if ln.strip() and not ln.strip().startswith("#")]

def collect_targets(single_targets: List[str], targets_file: Optional[str]) -> List[str]:
    """Collect and deduplicate targets from CLI args and targets file."""
    items = list(single_targets or [])
    if targets_file:
        pth = Path(targets_file)
        if pth.exists():
            for ln in read_text(pth).splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    items.append(ln)
    out = []
    for t in items:
        out.extend([x.strip() for x in t.split(",") if x.strip()])
    seen = set()
    res = []
    for t in out:
        if t not in seen:
            seen.add(t)
            res.append(t)
    return res

def norm_api_path(pth: str) -> str:
    """Normalize API path by stripping whitespace and trailing slashes."""
    return pth.strip().rstrip("/")

def rel_to(root: Path, file: Path) -> str:
    """Get relative path from root, or absolute if not relative."""
    try: 
        return file.relative_to(root).as_posix()
    except Exception: 
        return file.as_posix()

# ---------------- Python analyzer ----------------
@dataclass
class PyFunction:
    """Represents a Python function with metadata."""
    qualname: str
    module: str
    class_name: Optional[str]
    name: str
    file: Path
    lineno: int
    end_lineno: int
    routes: List[str] = field(default_factory=list)
    decorators: List[str] = field(default_factory=list)
    calls: Set[str] = field(default_factory=set)
    docstring: Optional[str] = None

@dataclass
class PyModuleIndex:
    """Index of functions and imports in a Python module."""
    functions: Dict[str, PyFunction] = field(default_factory=dict)
    module_aliases: Dict[str, str] = field(default_factory=dict)
    imported_symbols: Dict[str, str] = field(default_factory=dict)
    local_function_names: Set[str] = field(default_factory=set)

@dataclass
class PyRepoIndex:
    """Repository-wide index of Python code."""
    modules: Dict[str, PyModuleIndex] = field(default_factory=dict)
    func_lookup: Dict[str, str] = field(default_factory=dict)
    file_of_module: Dict[str, Path] = field(default_factory=dict)
    module_of_file: Dict[Path, str] = field(default_factory=dict)
    django_url_targets: Dict[str, Set[str]] = field(default_factory=dict)

ROUTE_ATTRS = {"get","post","put","delete","patch","route"}

def rel_module_from_path(repo_root: Path, file_path: Path) -> str:
    """Convert file path to Python module name."""
    rel = file_path.resolve().relative_to(repo_root.resolve())
    if rel.suffix == ".py":
        return ".".join(rel.with_suffix("").parts)
    return "/".join(rel.parts)

class PyAnalyzer(ast.NodeVisitor):
    """AST visitor for analyzing Python code."""
    
    def __init__(self, module: str, file: Path):
        self.module = module
        self.file = file
        self.index = PyModuleIndex()
        self.class_stack: List[str] = []
        self.source = read_text(file)

    def visit_Import(self, node: ast.Import):
        """Track import statements."""
        for alias in node.names:
            self.index.module_aliases[alias.asname or alias.name.split(".")[0]] = alias.name

    def visit_ImportFrom(self, node: ast.ImportFrom):
        """Track from-import statements."""
        mod = node.module or ""
        for alias in node.names:
            name = alias.name
            fq = f"{mod}.{name}" if mod else name
            self.index.imported_symbols[alias.asname or name] = fq

    def _decorator_route(self, dec: ast.expr) -> Optional[str]:
        """Extract route path from decorator."""
        if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
            if dec.func.attr in ROUTE_ATTRS:
                if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
                    return dec.args[0].value
                for kw in dec.keywords or []:
                    if kw.arg in ("path","rule") and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                        return kw.value.value
        return None

    def _decorator_name(self, dec: ast.expr) -> str:
        """Get decorator name as string."""
        try: 
            return ast.unparse(dec)
        except Exception: 
            return str(dec)

    def _qualname(self, name: str) -> str:
        """Get fully qualified name for function."""
        return f"{self.module}.{self.class_stack[-1]}.{name}" if self.class_stack else f"{self.module}.{name}"

    def _collect_calls(self, node: ast.AST) -> Set[str]:
        """Collect all function calls in a node."""
        calls: Set[str] = set()
        for ch in ast.walk(node):
            if isinstance(ch, ast.Call):
                if isinstance(ch.func, ast.Name):
                    calls.add(ch.func.id)
                elif isinstance(ch.func, ast.Attribute):
                    chain = []
                    cur = ch.func
                    while isinstance(cur, ast.Attribute):
                        chain.append(cur.attr)
                        cur = cur.value
                    if isinstance(cur, ast.Name):
                        chain.append(cur.id)
                        chain = list(reversed(chain))
                        calls.add(".".join(chain))
        return calls

    def visit_ClassDef(self, node: ast.ClassDef):
        """Visit class definition."""
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        """Visit function definition."""
        q = self._qualname(node.name)
        self.index.local_function_names.add(node.name)
        f = PyFunction(
            qualname=q, 
            module=self.module, 
            class_name=self.class_stack[-1] if self.class_stack else None,
            name=node.name, 
            file=self.file, 
            lineno=node.lineno, 
            end_lineno=getattr(node,"end_lineno",node.lineno),
            decorators=[self._decorator_name(d) for d in node.decorator_list],
            calls=self._collect_calls(node), 
            docstring=ast.get_docstring(node)
        )
        for d in node.decorator_list:
            r = self._decorator_route(d)
            if r: 
                f.routes.append(r)
        self.index.functions[q] = f
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        """Visit async function definition."""
        self.visit_FunctionDef(node)

DJANGO_URL_FUNC_NAMES = {"path","re_path","url"}
DJANGO_CBVIEW_SUFFIX = ".as_view"

def build_python_index(repo_root: Path, ignore_globs: List[str], max_files: Optional[int]) -> PyRepoIndex:
    """Build complete index of Python code in repository."""
    py = PyRepoIndex()
    count = 0
    
    for path in repo_root.rglob("*.py"):
        if should_skip(path, ignore_globs): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        module = rel_module_from_path(repo_root, path)
        py.file_of_module[module] = path
        py.module_of_file[path] = module
        
        src = read_text(path)
        try: 
            tree = ast.parse(src)
        except SyntaxError as e:
            logging.warning(f"Syntax error in {path}: {e}")
            continue
        except Exception as e:
            logging.warning(f"Failed to parse {path}: {e}")
            continue
        
        # Parse Django URL patterns
        if path.name.endswith("urls.py"):
            try:
                pattern = rf"(?P<fn>{'|'.join(DJANGO_URL_FUNC_NAMES)})\s*\(\s*([ru]?['\"])(?P<route>[^'\"]+)\2\s*,\s*(?P<view>[A-Za-z_][\w\.]*)"
                for m in re.finditer(pattern, src):
                    route = m.group("route")
                    view = m.group("view")
                    view = view.replace(".as_view","").replace("()","")
                    py.django_url_targets.setdefault(route, set()).add(view)
            except Exception as e:
                logging.debug(f"Failed to parse Django URLs in {path}: {e}")
        
        analyzer = PyAnalyzer(module, path)
        analyzer.visit(tree)
        py.modules[module] = analyzer.index

    # Build function lookup table
    for module, idx in py.modules.items():
        for fn in idx.functions.values():
            py.func_lookup[fn.qualname] = fn.qualname
            py.func_lookup.setdefault(fn.name, fn.qualname)
            py.func_lookup[f"{module}.{fn.name}"] = fn.qualname
    
    logging.info(f"Indexed {len(py.modules)} Python modules with {len(py.func_lookup)} functions")
    return py

def resolve_python_calls(py: PyRepoIndex) -> Dict[str, Set[str]]:
    """Build call graph edges from Python AST analysis."""
    edges: Dict[str, Set[str]] = {}
    
    for module, idx in py.modules.items():
        local = {fn.name: fn.qualname for fn in idx.functions.values()}
        imported = dict(idx.imported_symbols)
        aliases = dict(idx.module_aliases)
        
        for fn in idx.functions.values():
            cal: Set[str] = set()
            for raw in fn.calls:
                cands: List[str] = []
                
                if "." not in raw:
                    if raw in local: 
                        cands.append(local[raw])
                    elif raw in imported: 
                        cands.append(imported[raw])
                    elif raw in py.func_lookup: 
                        cands.append(py.func_lookup[raw])
                else:
                    parts = raw.split(".")
                    if parts[0] in aliases: 
                        parts[0] = aliases[parts[0]]
                    cands.append(".".join(parts))
                
                for c in cands:
                    if c in py.func_lookup: 
                        cal.add(py.func_lookup[c])
            
            edges[fn.qualname] = cal
    
    return edges

def find_python_roots(py: PyRepoIndex, targets: List[str], api_type: str) -> Set[str]:
    """Find root functions that match the target specifications."""
    roots: Set[str] = set()
    
    for target in targets:
        if api_type == "http":
            t = norm_api_path(target)
            # Check function routes
            for idx in py.modules.values():
                for f in idx.functions.values():
                    if any(norm_api_path(r) == t for r in f.routes):
                        roots.add(f.qualname)
                        logging.debug(f"Found HTTP route '{t}' -> {f.qualname}")
            
            # Check Django URL patterns
            for route, views in py.django_url_targets.items():
                if norm_api_path(route) == t:
                    for v in views:
                        if v in py.func_lookup: 
                            roots.add(py.func_lookup[v])
                        else:
                            for key, fq in py.func_lookup.items():
                                if key.endswith("." + v) or key == v: 
                                    roots.add(fq)
        else:
            # Function mode
            cand = target if ":" not in target else target.replace(":", ".", 1)
            if cand in py.func_lookup: 
                roots.add(py.func_lookup[cand])
            else:
                for key, fq in py.func_lookup.items():
                    if key.endswith("." + cand) or key == cand: 
                        roots.add(fq)
    
    logging.info(f"Found {len(roots)} Python root functions for targets: {targets}")
    return roots

# ---------------- Heuristic analyzers ----------------
def analyze_js(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze JavaScript/TypeScript code for routes and functions."""
    # FIXED: All regex patterns use single backslashes
    route_re = re.compile(r"""(?:app|router)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)""")
    controller_re = re.compile(r"""@Controller\(\s*['"]([^'"]*)['"]\s*\)""")
    method_dec_re = re.compile(r"""@(Get|Post|Put|Delete|Patch)\(\s*['"]([^'"]*)['"]\s*\)\s*(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(""")
    func_def_re = re.compile(r"""function\s+([A-Za-z_$][\w$]*)\s*\(""")
    call_re = re.compile(r"""([A-Za-z_$][\w$]*)\s*\(""")
    
    files = []
    count = 0
    for pth in repo.rglob("*"):
        if pth.suffix not in (".js",".ts",".tsx"): 
            continue
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    funcs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        
        # Express/Fastify routes
        for m in route_re.finditer(txt):
            _, path, handler = m.groups()
            routes.setdefault(norm_api_path(path), set()).add(f.as_posix() + ":" + handler)
        
        # NestJS controllers
        bases = [m.group(1) for m in controller_re.finditer(txt)]
        if bases:
            for mm in method_dec_re.finditer(txt):
                _, child, meth = mm.groups()
                for b in bases:
                    full = ("/" + "/".join([b.strip("/"), child.strip("/")])).replace("//","/")
                    routes.setdefault(norm_api_path(full), set()).add(f.as_posix() + ":" + meth)
        
        funcs_in_file[f] = set(m.group(1) for m in func_def_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = funcs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"JS/TS: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

def analyze_java(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze Java Spring code for REST endpoints."""
    # FIXED: All regex patterns use single backslashes
    class_route_re = re.compile(r"""@RequestMapping\(\s*(?:value|path)?\s*=\s*["']([^"']+)["']\s*\)""")
    method_map_re = re.compile(r"""@(?:Get|Post|Put|Delete|Patch|Request)Mapping\(([^)]*)\)""")
    method_path_re = re.compile(r"""(?:value|path)?\s*=\s*["']([^"']+)["']""")
    method_decl_re = re.compile(r"""(?:public|private|protected)?\s*(?:static\s+)?[\w\<\>\[\]]+\s+([A-Za-z_]\w*)\s*\(""")
    call_re = re.compile(r"""([A-Za-z_]\w*)\s*\(""")
    
    files = []
    count = 0
    for pth in repo.rglob("*.java"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    defs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        
        # Find class-level route
        base = None
        cm = class_route_re.search(txt)
        if cm: 
            base = cm.group(1)
        
        # Find method-level routes
        for mm in method_map_re.finditer(txt):
            arg = mm.group(1)
            pm = method_path_re.search(arg)
            path = pm.group(1) if pm else ""
            
            # Find the method declaration following the annotation
            after = txt.find(")", mm.end()) + 1
            md = method_decl_re.search(txt, pos=max(mm.end(), after))
            if md:
                mname = md.group(1)
                full = "/".join(x.strip("/") for x in ([base] if base else []) + [path]) if path else (base or "")
                full = ("/" + full).replace("//", "/")
                if full.strip("/"):
                    routes.setdefault(norm_api_path(full), set()).add(f.as_posix() + ":" + mname)
        
        defs_in_file[f] = set(m.group(1) for m in method_decl_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = defs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"Java: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

def analyze_go(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze Go code for HTTP handlers."""
    # FIXED: All regex patterns use single backslashes
    route_re = re.compile(r"""(?:\b(?:r|e)\.(GET|POST|PUT|DELETE|PATCH)|\bhttp\.HandleFunc|\bmux\.HandleFunc|\br\.HandleFunc)\(\s*["`]([^"`]+)["`]\s*,\s*([A-Za-z_]\w*)""")
    func_re = re.compile(r"""func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(""")
    call_re = re.compile(r"""([A-Za-z_]\w*)\s*\(""")
    
    files = []
    count = 0
    for pth in repo.rglob("*.go"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    defs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        
        for m in route_re.finditer(txt):
            path = m.group(2)
            handler = m.group(3)
            routes.setdefault(norm_api_path(path), set()).add(f.as_posix() + ":" + handler)
        
        defs_in_file[f] = set(m.group(1) for m in func_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = defs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"Go: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

def analyze_ruby(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze Ruby on Rails code for routes and controllers."""
    # FIXED: All regex patterns use single backslashes
    routes_rb = list(repo.rglob("config/routes.rb"))
    controller_method_re = re.compile(r"""def\s+([A-Za-z_]\w*)""")
    call_re = re.compile(r"""([A-Za-z_]\w*)\s*\(""")
    
    routes = {}
    files = []
    count = 0
    
    for pth in repo.rglob("*.rb"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    # Parse routes.rb
    for r in routes_rb:
        txt = read_text(r)
        for m in re.finditer(r"""['"]([^'"]+)['"]\s*,\s*to:\s*['"]([A-Za-z_/]+)#([A-Za-z_]\w*)['"]""", txt):
            path = m.group(1)
            ctrl = m.group(2)
            act = m.group(3)
            ctrl_file = repo / f"app/controllers/{ctrl}_controller.rb"
            node = (ctrl_file.as_posix() + ":" + act) if ctrl_file.exists() else (r.as_posix() + ":" + act)
            routes.setdefault(norm_api_path(path), set()).add(node)
    
    defs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        defs_in_file[f] = set(m.group(1) for m in controller_method_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = defs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"Ruby: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

def analyze_php(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze PHP Laravel code for routes and controllers."""
    # FIXED: All regex patterns use single backslashes
    route_re = re.compile(r"""Route::(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Za-z_]\w+)::class\s*,\s*['"]([A-Za-z_]\w*)['"]\s*\]""")
    func_re = re.compile(r"""function\s+([A-Za-z_]\w*)\s*\(""")
    call_re = re.compile(r"""([A-Za-z_]\w*)\s*\(""")
    
    files = []
    count = 0
    for pth in repo.rglob("*.php"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    defs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        
        for m in route_re.finditer(txt):
            path = m.group(2)
            meth = m.group(4)
            routes.setdefault(norm_api_path(path), set()).add(f.as_posix() + ":" + meth)
        
        defs_in_file[f] = set(m.group(1) for m in func_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = defs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"PHP: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

def analyze_cs(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze C# ASP.NET code for REST endpoints."""
    # FIXED: All regex patterns use single backslashes
    class_route_re = re.compile(r"""\[Route\(\s*["']([^"']+)["']\s*\)\]""")
    method_route_re = re.compile(r"""\[Http(?:Get|Post|Put|Delete|Patch)\(\s*["']([^"']+)["']\s*\)\]""")
    method_decl_re = re.compile(r"""(?:public|private|protected)\s+(?:async\s+)?[\w\<\>\[\]]+\s+([A-Za-z_]\w*)\s*\(""")
    map_re = re.compile(r"""app\.Map(?:Get|Post|Put|Delete|Patch)\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_]\w*)""")
    call_re = re.compile(r"""([A-Za-z_]\w*)\s*\(""")
    
    files = []
    count = 0
    for pth in repo.rglob("*.cs"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    defs_in_file = {}
    calls_in_file = {}
    
    for f in files:
        txt = read_text(f)
        base = None
        
        # Find class-level route
        cm = class_route_re.search(txt)
        if cm: 
            base = cm.group(1)
        
        # Find method-level routes
        for mm in method_route_re.finditer(txt):
            path = mm.group(1)
            md = method_decl_re.search(txt, pos=mm.end())
            if md:
                name = md.group(1)
                full = "/".join(x.strip("/") for x in ([base] if base else []) + [path])
                full = (("/" + full) if full else path).replace("//", "/")
                routes.setdefault(norm_api_path(full or path), set()).add(f.as_posix() + ":" + name)
        
        # Minimal API routes
        for m in map_re.finditer(txt):
            path = m.group(1)
            handler = m.group(2)
            routes.setdefault(norm_api_path(path), set()).add(f.as_posix() + ":" + handler)
        
        defs_in_file[f] = set(m.group(1) for m in method_decl_re.finditer(txt))
        calls_in_file[f] = set(m.group(1) for m in call_re.finditer(txt))
    
    # Build call graph
    edges = {}
    for f in files:
        prefix = f.as_posix() + ":"
        defined = defs_in_file.get(f, set())
        called = calls_in_file.get(f, set())
        
        for fn in defined:
            k = prefix + fn
            edges.setdefault(k, set())
            for c in called:
                if c in defined: 
                    edges[k].add(prefix + c)
    
    # Find roots
    roots = set()
    tt = {norm_api_path(t) for t in targets}
    for path, nodes in routes.items():
        if path in tt: 
            roots.update(nodes)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"C#: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

# ---------------- slicing, hints, outputs, ranking, rewrite ----------------
def reachable(edges: Dict[str, Set[str]], roots: Set[str]) -> Set[str]:
    """Find all nodes reachable from roots via DFS."""
    seen = set()
    stack = list(roots)
    
    while stack:
        cur = stack.pop()
        if cur in seen: 
            continue
        seen.add(cur)
        for nxt in edges.get(cur, set()):
            if nxt not in seen: 
                stack.append(nxt)
    
    return seen

def coalesce_ranges(ranges: List[Tuple[int,int,List[str]]]) -> List[Tuple[int,int,List[str]]]:
    """Merge overlapping or adjacent line ranges."""
    if not ranges:
        return []
    
    ranges.sort(key=lambda x: x[0])
    merged = []
    
    for s, e, names in ranges:
        if not merged or s > merged[-1][1] + 1:
            merged.append([s, e, list(names)])
        else:
            merged[-1][1] = max(merged[-1][1], e)
            for n in names:
                if n not in merged[-1][2]: 
                    merged[-1][2].append(n)
    
    return [(a, b, ns) for a, b, ns in merged]

def find_function_bounds(text: str, sym: str) -> Tuple[int,int]:
    """Find approximate line bounds for a function by name."""
    lines = text.splitlines()
    pat = re.compile(rf"^\s*(?:def|function|func|public|private|protected).*?\b{re.escape(sym)}\s*\(", re.I)
    start = 1
    end = min(len(lines), start + 1)
    
    for i, ln in enumerate(lines, 1):
        if pat.search(ln): 
            start = max(1, i)
            end = min(len(lines), i + 80)
            break
    
    return start, end

def extract_blocks(repo_root: Path, nodes: Set[str], context: int, hints: List[str]):
    """Extract code blocks for nodes and hint matches."""
    by_file = {}
    by_hint = {}
    
    # Extract blocks for each node
    for n in nodes:
        if ":" in n:
            path, sym = n.split(":", 1)
        else:
            # Skip nodes without file paths (e.g., qualnames like "module.function")
            continue
        
        f = Path(path)
        if not f.exists():
            logging.debug(f"Skipping non-existent path: {path}")
            continue
        
        txt = read_text(f)
        if not txt: 
            continue
        
        if sym: 
            s, e = find_function_bounds(txt, sym)
        else: 
            s, e = 1, min(200, len(txt.splitlines()))
        
        s = max(1, s - context)
        e = min(len(txt.splitlines()), e + context)
        by_file.setdefault(f, []).append((s, e, [sym] if sym else []))
    
    # Extract hint matches
    if hints:
        for f in list(by_file.keys()):
            txt = read_text(f)
            lines = txt.splitlines()
            
            for i, ln in enumerate(lines, 1):
                if any(h.lower() in ln.lower() for h in hints):
                    s = max(1, i - context)
                    e = min(len(lines), i + context)
                    by_hint.setdefault(f, []).append((s, e, ln.strip()))
        
        # Coalesce hint ranges
        for f, v in list(by_hint.items()):
            v.sort(key=lambda x: x[0])
            merged = []
            for s, e, ln in v:
                if not merged or s > merged[-1][1] + 1: 
                    merged.append([s, e, ln])
                else: 
                    merged[-1][1] = max(merged[-1][1], e)
            by_hint[f] = [(a, b, c) for a, b, c in merged]
    
    # Coalesce all ranges
    for f in list(by_file.keys()):
        by_file[f] = coalesce_ranges(by_file[f])
    
    return by_file, by_hint

def write_slice(repo_root: Path, out_dir: Path, blocks, hint_blocks, context: int):
    """Write extracted code slices to markdown and JSONL."""
    ensure_dir(out_dir)
    md = out_dir / "slice.md"
    jl = out_dir / "snippets.jsonl"
    idx = 0
    
    with md.open("w", encoding="utf-8") as m, jl.open("w", encoding="utf-8") as j:
        m.write(f"# Code Slice\n\n- Files: **{len(blocks)}**\n- Context lines: **{context}**\n\n## Snippets\n\n")
        
        for f, ranges in sorted(blocks.items(), key=lambda kv: kv[0].as_posix()):
            rel = rel_to(repo_root, f)
            lines = read_text(f).splitlines()
            m.write(f"### `{rel}`\n\n")
            
            for s, e, names in ranges:
                idx += 1
                code = "\n".join(lines[s-1:e])
                
                # Determine language for syntax highlighting
                lang = "python" if f.suffix == ".py" else (
                    "javascript" if f.suffix in (".js", ".ts", ".tsx") else (
                    "java" if f.suffix == ".java" else (
                    "go" if f.suffix == ".go" else (
                    "ruby" if f.suffix == ".rb" else (
                    "php" if f.suffix == ".php" else (
                    "csharp" if f.suffix == ".cs" else ""))))))
                
                m.write(f"**Block {idx} (lines {s}–{e})**\n\n```{lang}\n{code}\n```\n\n")
                j.write(json.dumps({
                    "index": idx,
                    "file": rel,
                    "start_line": s,
                    "end_line": e,
                    "symbols": names,
                    "language": lang or "text",
                    "text": code
                }, ensure_ascii=False) + "\n")
        
        # Write hint matches
        if hint_blocks:
            m.write("\n## Hint Matches\n\n")
            for f, ranges in sorted(hint_blocks.items(), key=lambda kv: kv[0].as_posix()):
                rel = rel_to(repo_root, f)
                lines = read_text(f).splitlines()
                m.write(f"### `{rel}`\n\n")
                
                for s, e, ln in ranges:
                    idx += 1
                    code = "\n".join(lines[s-1:e])
                    m.write(f"_match: `{ln}`_\n\n```text\n{code}\n```\n\n")
                    j.write(json.dumps({
                        "index": idx,
                        "file": rel,
                        "start_line": s,
                        "end_line": e,
                        "hint_match": ln,
                        "text": code
                    }, ensure_ascii=False) + "\n")

def write_graph(out_dir: Path, edges: Dict[str, Set[str]], selected: Set[str]):
    """Write call graph in DOT format."""
    dot = out_dir / "graph.dot"
    
    with dot.open("w", encoding="utf-8") as d:
        d.write("digraph Slice {\n  rankdir=LR;\n  node [shape=box, fontname=\"Helvetica\"];\n")
        for a, bs in edges.items():
            if a not in selected: 
                continue
            for b in bs:
                if b in selected: 
                    d.write(f'  "{a}" -> "{b}";\n')
        d.write("}\n")

def write_meta(out_dir: Path, files: Iterable[Path], context: int, routes_index: Dict[str, Set[str]], roots: Set[str]):
    """Write metadata about the slice."""
    meta = {
        "files": [f.as_posix() for f in files],
        "context": context,
        "routes": {k: list(v) for k, v in routes_index.items()},
        "roots": sorted(roots)
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

def write_prompt_pack(out_dir: Path, repo_root: Path):
    """Create prompt pack directory with individual snippet files."""
    pack = out_dir / "prompt_pack"
    ensure_dir(pack / "snippets")
    
    (pack / "prompt.md").write_text(
        "# Feature Request / Bugfix Brief\n\n"
        "Describe the change:\n\n- Desired behavior\n- Inputs/outputs\n- Tests\n\n"
        "## Instructions\n- Read snippets; output unified diff.\n", 
        encoding="utf-8"
    )
    
    src = out_dir / "snippets.jsonl"
    if src.exists():
        for line in read_text(src).splitlines():
            try:
                o = json.loads(line)
                filename = f"{o['index']:03d}_{Path(o['file']).name}.txt"
                content = f"// {o['file']}:{o['start_line']}-{o['end_line']}\n{o['text']}"
                (pack / "snippets" / filename).write_text(content, encoding="utf-8")
            except Exception as e:
                logging.debug(f"Failed to write prompt pack snippet: {e}")

def write_ranking(out_dir: Path, edges: Dict[str, Set[str]], roots: Set[str]):
    """Write CSV with node rankings by distance from roots."""
    from collections import deque, defaultdict
    
    # Calculate distances from roots
    dist = {}
    q = deque()
    for r in roots: 
        dist[r] = 0
        q.append(r)
    
    while q:
        u = q.popleft()
        for v in edges.get(u, set()):
            if v not in dist: 
                dist[v] = dist[u] + 1
                q.append(v)
    
    # Calculate degrees
    indeg = defaultdict(int)
    outdeg = {k: len(v) for k, v in edges.items()}
    for a, bs in edges.items():
        for b in bs: 
            indeg[b] += 1
    
    # Write CSV
    csv = out_dir / "ranked_functions.csv"
    with csv.open("w", encoding="utf-8") as f:
        f.write("node,distance,out_degree,in_degree\n")
        allnodes = set(edges.keys()) | {b for s in edges.values() for b in s}
        for n in sorted(allnodes):
            f.write(f"{n},{dist.get(n,'')},{outdeg.get(n,0)},{indeg.get(n,0)}\n")

def copy_impacted_files(out_dir: Path, repo_root: Path, blocks):
    """Copy impacted files to output directory preserving structure."""
    files_dir = out_dir / "files"
    ensure_dir(files_dir)
    
    for f in blocks.keys():
        try:
            rel = f.relative_to(repo_root)
            dst = files_dir / rel
            # Security: Ensure destination is within files_dir
            dst.resolve().relative_to(files_dir.resolve())
            ensure_dir(dst.parent)
            shutil.copy2(f, dst)
        except ValueError as e:
            logging.warning(f"Skipping {f}: outside repository or invalid path")
        except Exception as e:
            logging.warning(f"Failed to copy {f}: {e}")

def load_replacements(path: Optional[str]):
    """Load replacement rules from JSON or YAML file."""
    if not path: 
        return []
    
    p = Path(path)
    txt = read_text(p)
    
    try:
        if p.suffix.lower() in (".yaml", ".yml"):
            if yaml is None: 
                raise RuntimeError("PyYAML not installed")
            return yaml.safe_load(txt) or []
        return json.loads(txt)
    except Exception as e:
        logging.error(f"Failed to parse replacements: {e}")
        return []

def apply_rules(text: str, rules: List[dict]) -> str:
    """Apply replacement rules to text."""
    out = text
    
    for r in rules:
        if "literal" in r:
            frm = r["literal"].get("from", "")
            to = r["literal"].get("to", "")
            if frm: 
                out = out.replace(frm, to)
        elif "regex" in r:
            pat = r["regex"].get("pattern", "")
            repl = r["regex"].get("repl", "")
            flags = r["regex"].get("flags", "")
            fl = 0
            if "i" in flags: fl |= re.IGNORECASE
            if "m" in flags: fl |= re.MULTILINE
            if "s" in flags: fl |= re.DOTALL
            try: 
                out = re.sub(pat, repl, out, flags=fl)
            except re.error as e: 
                logging.warning(f"Bad regex {pat}: {e}")
    
    return out

def rewrite_files(repo_root: Path, out_dir: Path, impacted: List[Path], rules: List[dict], apply_all: bool, extra_glob: Optional[str]):
    """Rewrite files with replacement rules and generate diff."""
    patched = out_dir / "patched"
    ensure_dir(patched)
    diff = out_dir / "changes.diff"
    
    files = []
    if apply_all:
        for pth in repo_root.rglob("*"):
            if pth.is_file(): 
                files.append(pth)
    else:
        files = list(impacted)
    
    if extra_glob:
        for pth in repo_root.rglob("*"):
            if fnmatch.fnmatch(pth.as_posix(), extra_glob) and pth.is_file() and pth not in files:
                files.append(pth)
    
    diffs = []
    for f in files:
        orig = read_text(f)
        new = orig
        
        # Filter rules by file glob
        fr = []
        for r in rules:
            g = r.get("file_glob")
            if g and not fnmatch.fnmatch(f.as_posix(), g): 
                continue
            fr.append(r)
        
        if not fr: 
            continue
        
        new = apply_rules(new, fr)
        
        if new != orig:
            try:
                rel = f.relative_to(repo_root)
                dst = patched / rel
                ensure_dir(dst.parent)
                dst.write_text(new, encoding="utf-8")
                
                ud = difflib.unified_diff(
                    orig.splitlines(keepends=True), 
                    new.splitlines(keepends=True), 
                    fromfile=f"a/{rel}", 
                    tofile=f"b/{rel}"
                )
                diffs.append("".join(ud))
            except Exception as e:
                logging.warning(f"Failed to write patched file {f}: {e}")
    
    if diffs: 
        diff.write_text("".join(diffs), encoding="utf-8")

# ---------------- gRPC & GraphQL analyzers ----------------
def analyze_grpc(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """
    Discover gRPC service/method roots and map to likely handler functions.
    Targets can be "Service/Method" or "package.Service/Method".
    """
    # FIXED: All regex patterns use single backslashes
    wanted = set(t.strip() for t in targets)
    
    # Parse proto files
    protos = list(repo.rglob("*.proto"))
    svc_methods = {}  # "Service/Method" -> set of file hints (proto paths)
    
    count = 0
    for pr in protos:
        if should_skip(pr, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(pr)
        
        # Capture package if present
        pkg = None
        m = re.search(r'^\s*package\s+([A-Za-z0-9_.]+)\s*;', txt, re.M)
        if m: 
            pkg = m.group(1)
        
        # Services and RPCs
        for sm in re.finditer(r'service\s+([A-Za-z_]\w*)\s*\{([^}]*)\}', txt, re.S):
            sname = sm.group(1)
            body = sm.group(2)
            for rm in re.finditer(r'rpc\s+([A-Za-z_]\w*)\s*\(', body):
                meth = rm.group(1)
                key1 = f"{sname}/{meth}"
                key2 = f"{pkg}.{sname}/{meth}" if pkg else None
                svc_methods.setdefault(key1, set()).add(pr.as_posix())
                if key2: 
                    svc_methods.setdefault(key2, set()).add(pr.as_posix())
    
    # Find matched service methods
    matched_service_methods = {k for k in svc_methods.keys() if any(k.endswith(t) or k == t for t in wanted)}
    if not matched_service_methods and wanted:
        # Allow targets given as just "Method" to match any service
        short = {t.split("/")[-1] for t in wanted}
        for k in svc_methods.keys():
            if k.split("/")[-1] in short:
                matched_service_methods.add(k)
    
    # Look for implementations across languages
    edges: Dict[str, Set[str]] = {}
    sel: Set[str] = set()
    route_index: Dict[str, Set[str]] = {k: set() for k in matched_service_methods}
    
    def add_node_edge(node: str):
        edges.setdefault(node, set())
        sel.add(node)
    
    # Python: *_pb2_grpc.py helpers and *Servicer classes
    count = 0
    for pyf in repo.rglob("*.py"):
        if should_skip(pyf, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(pyf)
        
        # class SomethingServicer: def Method(self, ...)
        for cm in re.finditer(r'class\s+([A-Za-z_]\w*Servicer)\s*\([^)]*\)\s*:\s*(.*?)\n\n', txt, re.S):
            cls = cm.group(1)
            body = cm.group(2)
            for mm in re.finditer(r'^\s*def\s+([A-Za-z_]\w*)\s*\(', body, re.M):
                mname = mm.group(1)
                # Map to any matched "*/mname"
                for sm in list(matched_service_methods):
                    if sm.split('/')[-1] == mname:
                        node = f"{pyf.as_posix()}:{cls}.{mname}"
                        add_node_edge(node)
                        route_index[sm].add(node)
    
    # Go: receiver methods
    count = 0
    for gof in repo.rglob("*.go"):
        if should_skip(gof, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(gof)
        # func (s *Server) Method(ctx context.Context, req *pb.Request) (...)
        for mm in re.finditer(r'func\s+\(\s*\*?[A-Za-z_]\w*\s*\)\s+([A-Za-z_]\w*)\s*\(', txt):
            mname = mm.group(1)
            for sm in list(matched_service_methods):
                if sm.split('/')[-1] == mname:
                    node = f"{gof.as_posix()}:{mname}"
                    add_node_edge(node)
                    route_index[sm].add(node)
    
    # Java: ImplBase overrides
    count = 0
    for jf in repo.rglob("*.java"):
        if should_skip(jf, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(jf)
        # class XService extends FooGrpc.FooImplBase { public void Method(...)
        if "ImplBase" in txt:
            for mm in re.finditer(r'\b(?:public|protected)\s+[^\(\)]+\s+([A-Za-z_]\w*)\s*\(', txt):
                mname = mm.group(1)
                for sm in list(matched_service_methods):
                    if sm.split('/')[-1] == mname:
                        node = f"{jf.as_posix()}:{mname}"
                        add_node_edge(node)
                        route_index[sm].add(node)
    
    # Node: addService({... Method: (call) => ... })
    count = 0
    for nf in repo.rglob("*.js"):
        if should_skip(nf, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(nf)
        if "addService" in txt or ".service" in txt:
            for mm in re.finditer(r'([A-Za-z_]\w*)\s*:\s*function\s*\(|([A-Za-z_]\w*)\s*:\s*\(', txt):
                mname = mm.group(1) or mm.group(2)
                if not mname: 
                    continue
                for sm in list(matched_service_methods):
                    if sm.split('/')[-1] == mname:
                        node = f"{nf.as_posix()}:{mname}"
                        add_node_edge(node)
                        route_index[sm].add(node)
    
    # Build intra-file call edges
    call_re = re.compile(r'([A-Za-z_]\w*)\s*\(')
    
    def func_defs_for(file: Path, exts: Tuple[str,...], pat):
        if file.suffix not in exts: 
            return set()
        return set(m.group(1) for m in pat.finditer(read_text(file)))
    
    py_def = re.compile(r'^\s*def\s+([A-Za-z_]\w*)\s*\(', re.M)
    go_def = re.compile(r'^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(', re.M)
    java_def = re.compile(r'^\s*(?:public|private|protected)\s+[^\(\)]+\s+([A-Za-z_]\w*)\s*\(', re.M)
    js_def = re.compile(r'^\s*function\s+([A-Za-z_]\w*)\s*\(', re.M)
    
    impl_files = {Path(n.split(':', 1)[0]) for nodes in route_index.values() for n in nodes if ':' in n}
    for f in impl_files:
        defs = (func_defs_for(f, ('.py',), py_def) | 
                func_defs_for(f, ('.go',), go_def) | 
                func_defs_for(f, ('.java',), java_def) | 
                func_defs_for(f, ('.js',), js_def))
        called = set(call_re.findall(read_text(f)))
        prefix = f.as_posix() + ":"
        
        for d in defs:
            edges.setdefault(prefix + d, set())
            for c in called:
                if c in defs:
                    edges[prefix + d].add(prefix + c)
    
    sel.update({n for nodes in route_index.values() for n in nodes})
    
    logging.info(f"gRPC: Found {len(matched_service_methods)} methods, {len(sel)} selected nodes")
    return edges, sel, route_index

def analyze_graphql(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """
    Discover GraphQL root fields and resolver functions.
    Targets like "Query.user" / "Mutation.createUser".
    """
    # FIXED: All regex patterns use single backslashes
    wanted = set(t.strip() for t in targets)
    routes = {}
    
    # Parse GraphQL schema files
    count = 0
    for sdl in list(repo.rglob("*.graphql")) + list(repo.rglob("*.gql")):
        if should_skip(sdl, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(sdl)
        for tm in re.finditer(r'type\s+(Query|Mutation|Subscription)\s*\{([^}]*)\}', txt, re.S|re.I):
            tname = tm.group(1)
            body = tm.group(2)
            for fm in re.finditer(r'([A-Za-z_]\w*)\s*\(', body):
                field = fm.group(1)
                routes.setdefault(f"{tname}.{field}", set()).add(sdl.as_posix() + ":SDL")
    
    # JavaScript/TypeScript resolvers
    count = 0
    for rf in list(repo.rglob("*.js")) + list(repo.rglob("*.ts")):
        if should_skip(rf, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(rf)
        for tm in re.finditer(r'(Query|Mutation)\s*:\s*\{([^}]+)\}', txt, re.S):
            tname = tm.group(1)
            body = tm.group(2)
            for fm in re.finditer(r'([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)', body):
                field, fn = fm.groups()
                routes.setdefault(f"{tname}.{field}", set()).add(rf.as_posix() + ":" + fn)
    
    # Python resolvers (Graphene, Strawberry)
    count = 0
    for pf in repo.rglob("*.py"):
        if should_skip(pf, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        
        txt = read_text(pf)
        if "ObjectType" in txt or "strawberry.type" in txt:
            # Graphene-style resolvers
            for cm in re.finditer(r'class\s+(Query|Mutation|Subscription)\s*\([^)]*\)\s*:\s*(.*?)\n\n', txt, re.S):
                tname = cm.group(1)
                body = cm.group(2)
                for rm in re.finditer(r'^\s*def\s+resolve_([A-Za-z_]\w*)\s*\(', body, re.M):
                    field = rm.group(1)
                    routes.setdefault(f"{tname}.{field}", set()).add(pf.as_posix() + f":resolve_{field}")
            
            # Strawberry-style resolvers
            for rm in re.finditer(r'@strawberry\.field\s*\ndef\s+([A-Za-z_]\w*)\s*\(', txt):
                field = rm.group(1)
                routes.setdefault(f"Query.{field}", set()).add(pf.as_posix() + f":{field}")
    
    # Filter routes by targets
    filt = {k: v for k, v in routes.items() if (not wanted) or any(k.endswith(t) or k == t for t in wanted)}
    
    # Build call graph for resolver files
    edges: Dict[str, Set[str]] = {}
    sel = set()
    call_re = re.compile(r'([A-Za-z_]\w*)\s*\(')
    
    def func_defs(file: Path):
        if file.suffix == ".py":
            return set(re.findall(r'^\s*def\s+([A-Za-z_]\w*)\s*\(', read_text(file), re.M))
        if file.suffix in (".js", ".ts"):
            return set(re.findall(r'^\s*function\s+([A-Za-z_]\w*)\s*\(', read_text(file), re.M))
        return set()
    
    impl_files = {Path(n.split(':', 1)[0]) for nodes in filt.values() for n in nodes if ":" in n}
    for f in impl_files:
        defs = func_defs(f)
        called = set(call_re.findall(read_text(f)))
        prefix = f.as_posix() + ":"
        
        for d in defs:
            edges.setdefault(prefix + d, set())
            for c in called:
                if c in defs: 
                    edges[prefix + d].add(prefix + c)
    
    sel.update({n for nodes in filt.values() for n in nodes})
    
    logging.info(f"GraphQL: Found {len(filt)} resolvers, {len(sel)} selected nodes")
    return edges, sel, {k: set(v) for k, v in filt.items()}

def analyze_java_webflux(repo: Path, targets: List[str], ignore: List[str], max_files: Optional[int]):
    """Analyze Java WebFlux reactive applications."""
    # FIXED: All regex patterns use single backslashes
    files = []
    count = 0
    
    for pth in repo.rglob("*.java"):
        if should_skip(pth, ignore): 
            continue
        count += 1
        if max_files and count > max_files: 
            break
        files.append(pth)
    
    routes = {}
    edges = {}
    
    # Patterns for WebFlux route definitions
    route_call = re.compile(r'(GET|POST|PUT|DELETE)\(\s*["\']([^"\']+)["\']\s*\)')
    handler_ref = re.compile(r'([A-Za-z_]\w*)::([A-Za-z_]\w*)')
    lam_call = re.compile(r'->\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(')
    method_def = re.compile(r'^\s*(?:public|private|protected)\s+[^\(\)]+\s+([A-Za-z_]\w*)\s*\(', re.M)
    call_re = re.compile(r'([A-Za-z_]\w*)\s*\(')
    
    for f in files:
        txt = read_text(f)
        paths = set()
        
        # Find route calls
        for m in route_call.finditer(txt):
            pths = [g for g in m.groups() if g]
            for p in pths: 
                paths.add(norm_api_path(p))
        
        methods = set()
        
        # Find handler references
        for m in handler_ref.finditer(txt): 
            methods.add(m.group(2))
        
        # Find lambda calls
        for m in lam_call.finditer(txt): 
            methods.add(m.group(2))
        
        # Map paths to methods
        for pth in paths:
            for m in methods:
                routes.setdefault(pth, set()).add(f.as_posix() + ":" + m)
    
    # Find target roots
    wanted = {norm_api_path(t) for t in targets}
    roots = set()
    for path, nodes in routes.items():
        if path in wanted: 
            roots.update(nodes)
    
    # Build call graph
    for f in files:
        txt = read_text(f)
        prefix = f.as_posix() + ":"
        defs = set(m.group(1) for m in method_def.finditer(txt))
        called = set(call_re.findall(txt))
        
        for d in defs:
            edges.setdefault(prefix + d, set())
            for c in called:
                if c in defs: 
                    edges[prefix + d].add(prefix + c)
    
    # Find reachable nodes
    sel = reachable(edges, roots)
    
    logging.info(f"Java WebFlux: {len(files)} files, {len(routes)} routes, {len(sel)} selected nodes")
    return {k: {c for c in v if c in sel} for k, v in edges.items() if k in sel}, sel, {k: set(v) for k, v in routes.items()}

# ---------------- main ----------------
def main():
    """Main entry point for the code slicer."""
    ap = argparse.ArgumentParser(
        description="Extract context around APIs/functions; export snippets & graphs; optional rewrites.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Extract Python code for a specific API endpoint
  %(prog)s --repo ./myapp --target "/api/users" --language py --out slice_out
  
  # Extract multiple targets with context
  %(prog)s --repo ./myapp --target "/api/users,/api/posts" --context 15 --out slice_out
  
  # Use targets file and create prompt pack
  %(prog)s --repo ./myapp --targets-file targets.txt --prompt-pack --out slice_out
  
  # Auto-detect language and copy files
  %(prog)s --repo ./myapp --target "/api/users" --copy-files --out slice_out
        """
    )
    
    ap.add_argument("--repo", required=True, help="Path to repository root")
    ap.add_argument("--target", action="append", help="API path or function root (repeatable or comma-separated)")
    ap.add_argument("--targets-file", help="File containing targets (one per line)")
    ap.add_argument("--language", 
                    choices=["auto","py","js","java","go","rb","php","cs","grpc","graphql","java-webflux"], 
                    default="auto",
                    help="Language to analyze (default: auto)")
    ap.add_argument("--api-type", choices=["http","function"], default="http",
                    help="Type of target: http routes or function names")
    ap.add_argument("--context", type=int, default=8,
                    help="Number of context lines before/after each snippet")
    ap.add_argument("--ignore-globs", nargs="*", default=None,
                    help="Additional glob patterns to ignore")
    ap.add_argument("--max-files", type=int, default=None,
                    help="Maximum number of files to process per language")
    ap.add_argument("--out", default="slice_out",
                    help="Output directory")
    ap.add_argument("--copy-files", action="store_true",
                    help="Copy impacted files to output directory")
    ap.add_argument("--prompt-pack", action="store_true",
                    help="Create prompt pack with individual snippet files")
    ap.add_argument("--hint", action="append",
                    help="Extra keyword to capture context blocks (repeatable)")
    ap.add_argument("--rewrite", help="Path to JSON/YAML file with replacement rules")
    ap.add_argument("--rewrite-all-files", action="store_true",
                    help="Apply rewrite rules to all files (not just impacted)")
    ap.add_argument("--rewrite-extra-glob",
                    help="Additional glob pattern for files to rewrite")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="Enable verbose logging")
    
    args = ap.parse_args()
    
    # Setup logging
    setup_logging(args.verbose)
    
    # Validate inputs
    repo_root = Path(args.repo).resolve()
    if not repo_root.exists():
        logging.error(f"Repository not found: {repo_root}")
        sys.exit(1)
    
    out_dir = Path(args.out).resolve()
    ensure_dir(out_dir)
    
    # Load ignore patterns
    ignore = DEFAULT_IGNORES + load_slicerignore(repo_root)
    if args.ignore_globs: 
        ignore += args.ignore_globs
    
    # Collect targets
    targets = collect_targets(args.target or [], args.targets_file)
    if not targets:
        logging.error("No targets provided. Use --target or --targets-file.")
        sys.exit(2)
    
    logging.info(f"Analyzing repository: {repo_root}")
    logging.info(f"Targets: {targets}")
    logging.info(f"Context lines: {args.context}")
    
    # Initialize aggregation structures
    aggregated_edges: Dict[str, Set[str]] = {}
    selected_nodes: Set[str] = set()
    routes_index: Dict[str, Set[str]] = {}
    roots: Set[str] = set()
    blocks_all: Dict[Path, List[Tuple[int,int,List[str]]]] = {}
    
    def merge_graph(edges, sel, rindex, new_roots):
        """Merge language-specific results into aggregated structures."""
        nonlocal aggregated_edges, selected_nodes, routes_index, roots
        for k, v in edges.items():
            aggregated_edges.setdefault(k, set()).update(v)
        selected_nodes.update(sel)
        for k, v in rindex.items():
            routes_index.setdefault(k, set()).update(v)
        roots.update(new_roots)
    
    # Determine languages to analyze
    langs = [args.language] if args.language != "auto" else ["py","js","java","go","rb","php","cs"]
    
    # Analyze Python
    if "py" in langs:
        logging.info("Analyzing Python code...")
        py = build_python_index(repo_root, ignore, args.max_files)
        pedges = resolve_python_calls(py)
        proots = find_python_roots(py, targets, args.api_type)
        psel = reachable(pedges, proots)
        
        # Extract snippet blocks from AST line numbers
        for fq in psel:
            found = None
            for idx in py.modules.values():
                if fq in idx.functions:
                    found = idx.functions[fq]
                    break
            if not found: 
                continue
            
            f = found.file
            s = max(1, found.lineno - args.context)
            e = found.end_lineno + args.context
            blocks_all.setdefault(f, []).append((s, e, [fq]))
        
        # Coalesce Python blocks
        for f in list(blocks_all.keys()):
            blocks_all[f] = coalesce_ranges(blocks_all[f])
        
        merge_graph({k: v for k, v in pedges.items() if k in psel}, psel, py.django_url_targets, proots)
    
    # Analyze gRPC
    if "grpc" in langs:
        logging.info("Analyzing gRPC code...")
        gedges, gsel, gindex = analyze_grpc(repo_root, targets, ignore, args.max_files)
        merge_graph(gedges, gsel, gindex, set())
    
    # Analyze GraphQL
    if "graphql" in langs:
        logging.info("Analyzing GraphQL code...")
        qledges, qlsel, qlindex = analyze_graphql(repo_root, targets, ignore, args.max_files)
        merge_graph(qledges, qlsel, qlindex, set())
    
    # Analyze Java WebFlux
    if "java-webflux" in langs:
        logging.info("Analyzing Java WebFlux code...")
        wfedges, wfsel, wfindex = analyze_java_webflux(repo_root, targets, ignore, args.max_files)
        merge_graph(wfedges, wfsel, wfindex, set())
    
    # Analyze JavaScript/TypeScript
    if "js" in langs:
        logging.info("Analyzing JavaScript/TypeScript code...")
        jedges, jsel, rindex = analyze_js(repo_root, targets, ignore, args.max_files)
        merge_graph(jedges, jsel, rindex, set())
    
    # Analyze Java
    if "java" in langs:
        logging.info("Analyzing Java code...")
        jaedges, jasel, rindex = analyze_java(repo_root, targets, ignore, args.max_files)
        merge_graph(jaedges, jasel, rindex, set())
    
    # Analyze Go
    if "go" in langs:
        logging.info("Analyzing Go code...")
        goedges, gosel, rindex = analyze_go(repo_root, targets, ignore, args.max_files)
        merge_graph(goedges, gosel, rindex, set())
    
    # Analyze Ruby
    if "rb" in langs:
        logging.info("Analyzing Ruby code...")
        rbedges, rbsel, rindex = analyze_ruby(repo_root, targets, ignore, args.max_files)
        merge_graph(rbedges, rbsel, rindex, set())
    
    # Analyze PHP
    if "php" in langs:
        logging.info("Analyzing PHP code...")
        phpedges, phpsel, rindex = analyze_php(repo_root, targets, ignore, args.max_files)
        merge_graph(phpedges, phpsel, rindex, set())
    
    # Analyze C#
    if "cs" in langs:
        logging.info("Analyzing C# code...")
        csedges, cssel, rindex = analyze_cs(repo_root, targets, ignore, args.max_files)
        merge_graph(csedges, cssel, rindex, set())
    
    # Build overall node set
    all_nodes = set(selected_nodes)
    for a, bs in aggregated_edges.items():
        all_nodes.add(a)
        all_nodes.update(bs)
    
    logging.info(f"Found {len(all_nodes)} total nodes, {len(aggregated_edges)} edges")
    
    # Heuristic extraction for non-Python nodes + hints
    logging.info("Extracting code blocks...")
    by_file_heur, by_hint = extract_blocks(repo_root, all_nodes, args.context, args.hint or [])
    for f, rs in by_file_heur.items():
        blocks_all.setdefault(f, []).extend(rs)
        blocks_all[f] = coalesce_ranges(blocks_all[f])
    
    # Write outputs
    logging.info("Writing outputs...")
    write_slice(repo_root, out_dir, blocks_all, by_hint, args.context)
    write_graph(out_dir, aggregated_edges, all_nodes)
    write_meta(out_dir, blocks_all.keys(), args.context, routes_index, roots)
    write_ranking(out_dir, aggregated_edges, all_nodes)
    
    if args.prompt_pack: 
        write_prompt_pack(out_dir, repo_root)
    
    if args.copy_files: 
        copy_impacted_files(out_dir, repo_root, blocks_all)
    
    if args.rewrite:
        rules = load_replacements(args.rewrite)
        impacted = list(blocks_all.keys())
        rewrite_files(repo_root, out_dir, impacted, rules, 
                     apply_all=args.rewrite_all_files, 
                     extra_glob=args.rewrite_extra_glob)
    
    # Print summary
    print(f"\n✅ Analysis complete! Output written to: {out_dir}")
    print(f"   📄 {len(blocks_all)} files analyzed")
    print(f"   📦 Snippets extracted and saved to:")
    print(f"      - slice.md (human-readable)")
    print(f"      - snippets.jsonl (machine-readable)")
    print(f"   📊 graph.dot (visualize with: dot -Tpng graph.dot -o graph.png)")
    print(f"   📋 meta.json (metadata)")
    print(f"   📈 ranked_functions.csv (node rankings)")
    
    if args.prompt_pack: 
        print(f"   📁 prompt_pack/ (individual snippet files)")
    if args.copy_files: 
        print(f"   📁 files/ (copied source files)")
    if args.rewrite: 
        print(f"   📁 patched/ (rewritten files)")
        print(f"   📝 changes.diff (unified diff)")
    
    print(f"\n💡 Tip: Use --verbose flag for detailed logging")

if __name__ == "__main__":
    main()