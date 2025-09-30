import re
from typing import Dict, Any


class DocVerifier:
    """Verify generated documentation quality.

    Same checks as original: length, placeholders, header, file references.
    """

    def __init__(self, docs: Dict[str, str], artifacts: Dict):
        self.docs = docs
        self.artifacts = artifacts

    async def verify(self) -> Dict[str, Any]:
        results = {'checks': [], 'warnings': [], 'errors': []}
        for path, content in self.docs.items():
            if len(content) < 100:
                results['errors'].append(f"{path}: Documentation too short")
            if '[TODO]' in content or 'FIXME' in content:
                results['warnings'].append(f"{path}: Contains placeholders")
            if not content.startswith('#'):
                results['warnings'].append(f"{path}: Missing header")
            file_refs = re.findall(r"`([^`]+\.(py|js|ts|go))`", content)
            for ref, _ext in file_refs:
                if ref not in self.artifacts.get('files', {}):
                    results['warnings'].append(f"{path}: References non-existent file {ref}")
            results['checks'].append(f"{path}: Verified")
        return results
