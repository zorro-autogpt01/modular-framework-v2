import hashlib
import json
import re
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any

from .github_hub import fetch_repo_tree, fetch_file_content


class CodeExtractor:
    """Extract structured information from a repository.

    This replicates the prior behavior but takes explicit cache_dir and (optionally)
    a github_base_url via the github_hub helpers.
    """

    def __init__(self, repo_url: str, branch: str, cache_dir: str | Path):
        self.repo_url = repo_url
        self.branch = branch
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_key = hashlib.sha256(f"{repo_url}:{branch}".encode()).hexdigest()

    async def extract(self) -> Dict[str, Any]:
        """Run extraction and return artifacts (structure, files, api_specs, schemas, tests)."""
        cache_file = self.cache_dir / f"{self.cache_key}.json"
        if cache_file.exists():
            with cache_file.open('r', encoding='utf-8') as f:
                return json.load(f)

        tree = await fetch_repo_tree(self.repo_url, self.branch)
        items = tree.get('items', [])

        artifacts = {
            'meta': {
                'repo': self.repo_url,
                'branch': self.branch,
                'extracted_at': datetime.utcnow().isoformat()
            },
            'structure': self._build_structure(items),
            'files': {},
            'api_specs': {},
            'configs': {},
            'schemas': {},
            'tests': []
        }

        for item in items:
            if item.get('type') != 'blob':
                continue
            path = item.get('path')

            # YAML/JSON candidates for API specs
            if re.match(r".*\.(yaml|yml|json)$", path, re.I):
                if 'openapi' in path.lower() or 'swagger' in path.lower():
                    content = await fetch_file_content(path, self.branch)
                    artifacts['api_specs'][path] = self._parse_openapi(content)

            elif path.endswith('.sql'):
                content = await fetch_file_content(path, self.branch)
                artifacts['schemas'][path] = content

            elif 'docker' in path.lower() or path.endswith('docker-compose.yml'):
                content = await fetch_file_content(path, self.branch)
                artifacts['configs'][path] = content

            elif 'test' in path.lower() or 'spec' in path.lower():
                artifacts['tests'].append(path)

            elif self._is_key_source_file(path):
                content = await fetch_file_content(path, self.branch)
                artifacts['files'][path] = {
                    'content': content,
                    'language': self._detect_language(path),
                    'symbols': self._extract_symbols(content, path)
                }

        with cache_file.open('w', encoding='utf-8') as f:
            json.dump(artifacts, f, indent=2)

        return artifacts

    def _build_structure(self, items: List[Dict]) -> Dict:
        root = {'type': 'dir', 'children': {}}
        for item in items:
            parts = item.get('path', '').split('/')
            current = root
            for i, part in enumerate(parts):
                is_leaf = (i == len(parts) - 1)
                if is_leaf:
                    if item.get('type') == 'blob':
                        current['children'][part] = {'type': 'file', 'size': item.get('size', 0)}
                    else:
                        current['children'][part] = {'type': 'dir', 'children': {}}
                else:
                    if part not in current['children']:
                        current['children'][part] = {'type': 'dir', 'children': {}}
                    current = current['children'][part]
        return root

    def _is_key_source_file(self, path: str) -> bool:
        key_patterns = [
            r".*/(index|main|app|server)\.(js|ts|py|go|java)$",
            r".*/routes/.*\.(js|ts|py)$",
            r".*/models/.*\.(js|ts|py)$",
            r".*/api/.*\.(js|ts|py)$",
        ]
        return any(re.match(p, path) for p in key_patterns)

    def _detect_language(self, path: str) -> str:
        ext = path.split('.')[-1].lower()
        mapping = {
            'js': 'javascript', 'ts': 'typescript', 'py': 'python',
            'go': 'go', 'java': 'java', 'rb': 'ruby', 'rs': 'rust'
        }
        return mapping.get(ext, 'unknown')

    def _extract_symbols(self, content: str, path: str) -> List[str]:
        symbols = []
        lang = self._detect_language(path)
        if lang in ['javascript', 'typescript']:
            symbols.extend(re.findall(r"(?:function|const|let|var|class)\s+(\w+)", content))
            symbols.extend(re.findall(r"(\w+)\s*:\s*(?:async\s*)?\(", content))
        elif lang == 'python':
            symbols.extend(re.findall(r"^(?:def|class)\s+(\w+)", content, re.M))
        # dedupe and cap
        return list(dict.fromkeys(symbols))[:50]

    def _parse_openapi(self, content: str) -> dict:
        try:
            import json, yaml
            spec = None
            if content.strip().startswith('{'):
                spec = json.loads(content)
            else:
                spec = yaml.safe_load(content)
            return {
                'version': spec.get('openapi', spec.get('swagger', 'unknown')),
                'paths': list(spec.get('paths', {}).keys()),
                'schemas': list(spec.get('components', {}).get('schemas', {}).keys())
            }
        except Exception:
            return {}
