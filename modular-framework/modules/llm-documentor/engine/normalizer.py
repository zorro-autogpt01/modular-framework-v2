import json
from typing import List, Dict, Any


class ChunkNormalizer:
    """Normalize and chunk artifacts for LLM consumption."""

    def __init__(self, artifacts: Dict[str, Any]):
        self.artifacts = artifacts

    def normalize(self) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []

        # Structure overview
        chunks.append({
            'type': 'structure',
            'content': self._format_structure(self.artifacts['structure']),
            'metadata': {
                'repo': self.artifacts['meta']['repo'],
                'branch': self.artifacts['meta']['branch']
            }
        })

        # API specs
        for path, spec in self.artifacts.get('api_specs', {}).items():
            chunks.append({'type': 'api_spec', 'path': path, 'content': json.dumps(spec, indent=2), 'metadata': {'version': spec.get('version')}})

        # Source files
        for path, file_info in self.artifacts.get('files', {}).items():
            content = file_info.get('content', '')
            if len(content) > 5000:
                for i, sub in enumerate(self._smart_chunk(content, file_info.get('language'))):
                    chunks.append({'type': 'source', 'path': path, 'part': i + 1, 'content': sub, 'language': file_info.get('language'), 'symbols': file_info.get('symbols')})
            else:
                chunks.append({'type': 'source', 'path': path, 'content': content, 'language': file_info.get('language'), 'symbols': file_info.get('symbols')})

        for path, content in self.artifacts.get('schemas', {}).items():
            chunks.append({'type': 'schema', 'path': path, 'content': content})

        return chunks

    def _format_structure(self, node: Dict, indent: int = 0) -> str:
        lines = []
        for name, child in node.get('children', {}).items():
            prefix = '  ' * indent
            if child['type'] == 'file':
                lines.append(f"{prefix}📄 {name}")
            else:
                lines.append(f"{prefix}📁 {name}")
                lines.append(self._format_structure(child, indent + 1))
        return '\n'.join(lines)

    def _smart_chunk(self, content: str, language: str, max_size: int = 3000) -> List[str]:
        chunks = []
        current = []
        size = 0
        lines = content.split('\n')
        for line in lines:
            is_boundary = False
            if language == 'python' and line.strip().startswith(('def ', 'class ')):
                is_boundary = True
            if language in ('javascript', 'typescript') and line.strip().startswith(('function ', 'class ', 'export ')):
                is_boundary = True

            if is_boundary and size > max_size // 2:
                chunks.append('\n'.join(current))
                current = []
                size = 0

            current.append(line)
            size += len(line)
            if size > max_size:
                chunks.append('\n'.join(current))
                current = []
                size = 0

        if current:
            chunks.append('\n'.join(current))
        return chunks
