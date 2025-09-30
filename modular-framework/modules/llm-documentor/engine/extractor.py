# modular-framework/modules/llm-documentor/engine/extractor.py
import os
import hashlib
import json
import re
import fnmatch
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional

from .github_hub import fetch_repo_tree, fetch_file_content


DEFAULT_DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DEFAULT_CACHE_DIR = DEFAULT_DATA_DIR / "cache"


class CodeExtractor:
    """
    Extract structured information from a repository with optional scope filtering.

    Compatible with app.py (which passes scope=...):
      scope = {
        "include_globs": [...],
        "exclude_globs": [...],
        "modules": [...],         # folder names under modules/
        "file_types": [...],      # e.g. ["py","ts","sql"]
        "force_refresh": bool,
      }
    """

    def __init__(
        self,
        repo_url: Optional[str],
        branch: str,
        cache_dir: str | Path | None = None,
        scope: Optional[Dict[str, Any]] = None,
        github_base_url: str | None = None,  # reserved for future use
    ):
        self.repo_url = repo_url  # may be None if github-hub is preconfigured
        self.branch = branch
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_key = hashlib.sha256(f"{repo_url or 'gh-hub'}:{branch}".encode()).hexdigest()

        scope = scope or {}
        self.include_globs: List[str] = list(scope.get("include_globs") or [])
        self.exclude_globs: List[str] = list(scope.get("exclude_globs") or [])
        self.modules: List[str] = list(scope.get("modules") or [])
        self.file_types: List[str] = [s.lower().lstrip(".") for s in (scope.get("file_types") or [])]
        self.force_refresh: bool = bool(scope.get("force_refresh") or False)

    async def extract(self) -> Dict[str, Any]:
        """Run extraction and return artifacts (structure, files, api_specs, schemas, tests, file_hashes)."""
        cache_file = self.cache_dir / f"{self.cache_key}.json"
        if cache_file.exists() and not self.force_refresh:
            with cache_file.open("r", encoding="utf-8") as f:
                return json.load(f)

        tree = await fetch_repo_tree(self.repo_url or "", self.branch)
        items = tree.get("items", [])

        # optional pre-filter for blobs according to scope (affects which files we fetch)
        blob_items = [it for it in items if it.get("type") == "blob"]
        blob_items = [it for it in blob_items if self._match_scope(it.get("path", ""))]

        artifacts: Dict[str, Any] = {
            "meta": {
                "repo": self.repo_url,
                "branch": self.branch,
                "extracted_at": datetime.utcnow().isoformat()
            },
            "structure": self._build_structure(items),  # full structure for UI
            "files": {},
            "api_specs": {},
            "configs": {},
            "schemas": {},
            "tests": [],
            "file_hashes": {},  # for incremental mode
        }

        for item in blob_items:
            path = item.get("path", "")

            # API specs (OpenAPI/Swagger)
            if re.match(r".*\.(yaml|yml|json)$", path, re.I):
                if "openapi" in path.lower() or "swagger" in path.lower():
                    content = await fetch_file_content(path, self.branch)
                    artifacts["api_specs"][path] = self._parse_openapi(content)
                    if content:
                        artifacts["file_hashes"][path] = self._hash_text(content)
                continue

            # DB schemas
            if path.lower().endswith(".sql"):
                content = await fetch_file_content(path, self.branch)
                artifacts["schemas"][path] = content
                if content:
                    artifacts["file_hashes"][path] = self._hash_text(content)
                continue

            # Docker/deployment configs
            lname = path.lower()
            if "docker" in lname or lname.endswith("docker-compose.yml") or lname.endswith("docker-compose.yaml"):
                content = await fetch_file_content(path, self.branch)
                artifacts["configs"][path] = content
                if content:
                    artifacts["file_hashes"][path] = self._hash_text(content)
                continue

            # Tests
            if "test" in lname or "spec" in lname:
                artifacts["tests"].append(path)
                # we don't fetch test content by default (can be changed if needed)
                continue

            # Source code files
            if self._is_source_candidate(path):
                content = await fetch_file_content(path, self.branch)
                artifacts["files"][path] = {
                    "content": content,
                    "language": self._detect_language(path),
                    "symbols": self._extract_symbols(content, path)
                }
                if content:
                    artifacts["file_hashes"][path] = self._hash_text(content)

        with cache_file.open("w", encoding="utf-8") as f:
            json.dump(artifacts, f, indent=2)

        return artifacts

    # ---------------- helpers ----------------

    def _build_structure(self, items: List[Dict]) -> Dict:
        root = {"type": "dir", "children": {}}
        for item in items:
            parts = item.get("path", "").split("/")
            current = root
            for i, part in enumerate(parts):
                is_leaf = (i == len(parts) - 1)
                if is_leaf:
                    if item.get("type") == "blob":
                        current.setdefault("children", {})[part] = {"type": "file", "size": item.get("size", 0)}
                    else:
                        current.setdefault("children", {})[part] = {"type": "dir", "children": {}}
                else:
                    if part not in current.setdefault("children", {}):
                        current["children"][part] = {"type": "dir", "children": {}}
                    current = current["children"][part]
        return root

    def _match_scope(self, path: str) -> bool:
        """
        Returns True if the file path passes the scope filters.
        - modules: restrict to "modules/<name>/**"
        - include_globs: at least one must match (if provided)
        - exclude_globs: none may match
        - file_types: extension must be in list (if provided)
        """
        if not path:
            return False

        # modules filter
        if self.modules:
            ok = False
            for m in self.modules:
                prefix = f"modules/{m.strip('/')}/"
                if path.startswith(prefix):
                    ok = True
                    break
            if not ok:
                return False

        # file_types filter
        if self.file_types:
            ext = path.split(".")[-1].lower() if "." in path else ""
            if ext not in self.file_types:
                return False

        # include_globs (if any => must match at least one)
        if self.include_globs:
            if not any(fnmatch.fnmatch(path, patt) for patt in self.include_globs):
                return False

        # exclude_globs (must not match)
        if self.exclude_globs:
            if any(fnmatch.fnmatch(path, patt) for patt in self.exclude_globs):
                return False

        return True

    def _is_source_candidate(self, path: str) -> bool:
        """
        If explicit filters are set, allow any file that passed _match_scope.
        Otherwise, fall back to 'key source file' heuristics to reduce noise.
        """
        if self.include_globs or self.modules or self.file_types:
            return True
        key_patterns = [
            r".*/(index|main|app|server)\.(js|ts|py|go|java)$",
            r".*/routes/.*\.(js|ts|py)$",
            r".*/models/.*\.(js|ts|py)$",
            r".*/api/.*\.(js|ts|py)$",
            r".*\.py$",  # slightly broader so we don't miss core modules
        ]
        return any(re.match(p, path) for p in key_patterns)

    def _detect_language(self, path: str) -> str:
        ext = path.split(".")[-1].lower()
        mapping = {
            "js": "javascript", "ts": "typescript", "py": "python",
            "go": "go", "java": "java", "rb": "ruby", "rs": "rust"
        }
        return mapping.get(ext, "unknown")

    def _extract_symbols(self, content: str, path: str) -> List[str]:
        symbols: List[str] = []
        lang = self._detect_language(path)
        if not content:
            return symbols
        if lang in ["javascript", "typescript"]:
            symbols.extend(re.findall(r"(?:function|const|let|var|class)\s+(\w+)", content))
            symbols.extend(re.findall(r"(\w+)\s*:\s*(?:async\s*)?\(", content))
        elif lang == "python":
            symbols.extend(re.findall(r"^(?:def|class)\s+(\w+)", content, re.M))
        # dedupe + cap
        return list(dict.fromkeys(symbols))[:50]

    def _parse_openapi(self, content: str) -> dict:
        try:
            import json as _json
            import yaml as _yaml
            if (content or "").strip().startswith("{"):
                spec = _json.loads(content or "{}")
            else:
                spec = _yaml.safe_load(content or "") or {}
            return {
                "version": spec.get("openapi", spec.get("swagger", "unknown")),
                "paths": list(spec.get("paths", {}).keys()),
                "schemas": list(spec.get("components", {}).get("schemas", {}).keys())
            }
        except Exception:
            return {}

    @staticmethod
    def _hash_text(s: str) -> str:
        return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()
