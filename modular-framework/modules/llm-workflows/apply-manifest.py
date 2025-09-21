#!/usr/bin/env python3
"""
apply_manifest.py — Create folders and files from a manifest that looks like:

# path/to/file.ext
<file contents line 1>
<file contents line 2>

# another/file
<more contents>
...

Usage:
  python3 apply_manifest.py manifest.txt --root . [--dry-run] [--mode overwrite|skip]
"""

import argparse
import os
import sys
from pathlib import Path
from typing import List, Tuple

HEADER_PREFIX = "# "

def parse_manifest(text: str) -> List[Tuple[str, str]]:
    """
    Parse the manifest into a list of (path, content) tuples.
    A header line starts with '# ' followed by the relative file path.
    Everything until the next header (or EOF) is the file content.
    """
    files: List[Tuple[str, str]] = []

    current_path: str | None = None
    current_lines: List[str] = []

    def flush():
        nonlocal current_path, current_lines, files
        if current_path is not None:
            # Join exactly as-is; do not trim trailing newlines
            content = "".join(current_lines)
            files.append((current_path.strip(), content))
        current_path, current_lines = None, []

    lines = text.splitlines(keepends=True)
    for line in lines:
        if line.startswith(HEADER_PREFIX):
            # New header -> flush previous
            flush()
            current_path = line[len(HEADER_PREFIX):].strip()
            # If the header line itself contained nothing else (normal case), continue
        else:
            current_lines.append(line)

    flush()
    # Filter out accidental blanks (e.g., preamble before first header)
    files = [(p, c) for (p, c) in files if p]
    return files

def write_file(root: Path, rel_path: str, content: str, dry_run: bool, mode: str) -> tuple[Path, str]:
    """
    Write content to root/rel_path. Creates parent directories as needed.
    mode: 'overwrite' or 'skip'
    Returns (absolute_path, action_taken)
    """
    safe_rel = rel_path.lstrip("/").replace("\\", "/")  # normalize
    dest = root / safe_rel
    action = "created"

    if dest.exists():
        if mode == "skip":
            return dest, "skipped (exists)"
        action = "overwritten"

    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Ensure consistent UTF-8 without altering newlines already present
        with open(dest, "w", encoding="utf-8", newline="") as f:
            f.write(content)

        # Make common script entrypoints executable
        if dest.suffix in (".sh",) or dest.name in ("gradlew",):
            try:
                mode_bits = dest.stat().st_mode
                dest.chmod(mode_bits | 0o111)
            except Exception:
                pass

    return dest, action

def main():
    ap = argparse.ArgumentParser(description="Apply a folder/file manifest to the filesystem.")
    ap.add_argument("manifest", help="Path to the manifest text file")
    ap.add_argument("--root", default=".", help="Root directory where files will be written (default: current dir)")
    ap.add_argument("--dry-run", action="store_true", help="Show what would happen without writing files")
    ap.add_argument("--mode", choices=["overwrite", "skip"], default="overwrite",
                    help="If a file exists, overwrite it or skip (default: overwrite)")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        print(f"ERROR: manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    text = manifest_path.read_text(encoding="utf-8")
    files = parse_manifest(text)

    if not files:
        print("No files found in manifest. Make sure each file section starts with '# <relative/path>'")
        sys.exit(1)

    root = Path(args.root).resolve()
    print(f"{'DRY RUN — ' if args.dry_run else ''}Applying manifest into: {root}")
    print(f"Mode: {args.mode}")
    print(f"Files found: {len(files)}")
    print("-" * 72)

    created = overwritten = skipped = 0
    for rel_path, content in files:
        dest, action = write_file(root, rel_path, content, args.dry_run, args.mode)
        print(f"{action:12}  {dest}")
        if action.startswith("created"):
            created += 1
        elif action.startswith("overwritten"):
            overwritten += 1
        else:
            skipped += 1

    print("-" * 72)
    print(f"Summary: created={created}, overwritten={overwritten}, skipped={skipped}")
    if args.dry_run:
        print("Nothing was written (dry run). Re-run without --dry-run to apply.")

if __name__ == "__main__":
    main()
