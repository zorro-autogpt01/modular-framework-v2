
from typing import List, Dict, Tuple
import re
from pathlib import Path

_DIFF_FILE_RE = re.compile(r'^(---|\+\+\+) (?:a/|b/)?(?P<path>[^\s]+)')
_HUNK_RE = re.compile(r'^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@')

def parse_unified_diff(patch_text: str) -> List[Dict]:
    """
    Parse a minimal subset of unified diff to extract changed files and hunks.
    Returns a list of {'file': str, 'hunks': List[Tuple[start_new, len_new]]}
    """
    files: List[Dict] = []
    current_file: Dict | None = None

    lines = patch_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _DIFF_FILE_RE.match(line)
        if m:
            # Expect a pair --- and +++; capture +++ file name
            tag = line[:3]
            if tag == '---':
                # Look ahead for +++
                j = i + 1
                while j < len(lines) and not lines[j].startswith('+++ '):
                    j += 1
                if j < len(lines):
                    m2 = _DIFF_FILE_RE.match(lines[j])
                    if m2:
                        # start a new file entry using +++ path (destination)
                        path = m2.group('path')
                        current_file = {"file": path, "hunks": []}
                        files.append(current_file)
                        i = j  # jump to +++
        else:
            hm = _HUNK_RE.match(line)
            if hm and current_file is not None:
                start_new = int(hm.group(3))
                len_new = int(hm.group(4) or '1')
                current_file["hunks"].append((start_new, len_new))
        i += 1
    return files

def _is_safe_path(path_str: str) -> bool:
    # Disallow absolute paths and path traversal
    p = Path(path_str)
    if p.is_absolute():
        return False
    parts = p.parts
    if any(part == '..' for part in parts):
        return False
    return True

def validate_patch(
    patch_text: str,
    repo_root: str | Path | None = None,
    restrict_to_files: List[str] | None = None,
    max_files: int = 50,
    max_patch_size_chars: int = 300_000
) -> Dict:
    """
    Validate generated patch:
    - Ensure only relative paths
    - Optionally ensure changed files are restricted to provided list
    - Enforce size limits
    - Optionally check files exist under repo_root (best effort)
    Returns: dict with ok: bool, issues: List[str], files: List[str]
    """
    issues: List[str] = []

    if not patch_text or not patch_text.strip():
        return {"ok": False, "issues": ["Empty patch"], "files": []}

    if len(patch_text) > max_patch_size_chars:
        issues.append(f"Patch exceeds size limit: {len(patch_text)} chars > {max_patch_size_chars}")

    parsed = parse_unified_diff(patch_text)
    if not parsed:
        issues.append("Could not parse unified diff structure (---/+++ and @@ hunks missing?)")

    files = [f["file"] for f in parsed] if parsed else []

    # Path safety
    for fp in files:
        if not _is_safe_path(fp):
            issues.append(f"Unsafe path detected: {fp}")

    # Restriction enforcement
    if restrict_to_files:
        allowed = set(restrict_to_files)
        for fp in files:
            if fp not in allowed:
                issues.append(f"File not allowed by restriction: {fp}")

    # Existence check
    if repo_root and files:
        root = Path(repo_root)
        for fp in files:
            try:
                candidate = (root / fp).resolve()
                if root.resolve() not in candidate.parents and root.resolve() != candidate:
                    issues.append(f"File outside repo root: {fp}")
                elif not candidate.exists():
                    # Not fatal; the patch may create files. Note only.
                    pass
            except Exception:
                pass

    if len(files) > max_files:
        issues.append(f"Too many files modified: {len(files)} > {max_files}")

    return {
        "ok": len(issues) == 0,
        "issues": issues,
        "files": files
    }
