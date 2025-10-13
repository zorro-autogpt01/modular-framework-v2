#!/usr/bin/env python3
import argparse, json, os, sys
from pathlib import Path

def load_json(source: str) -> dict:
    # If parsing fails, try a quick fix for `{ files": ... }` -> `{"files": ... }`
    try:
        return json.loads(source)
    except json.JSONDecodeError:
        fixed = source.replace('{\\n files"', '{\n  "files"', 1).replace('{ files"', '{"files"', 1)
        return json.loads(fixed)

def main():
    p = argparse.ArgumentParser(description="Create files from a JSON spec.")
    p.add_argument("json_file", nargs="?", help="Path to JSON file (defaults to stdin)")
    p.add_argument("--root", default=".", help="Root directory to write into (default: current dir)")
    p.add_argument("--overwrite", action="store_true", help="Allow overwriting existing files")
    args = p.parse_args()

    # Read input
    if args.json_file:
        text = Path(args.json_file).read_text(encoding="utf-8")
    else:
        text = sys.stdin.read()

    data = load_json(text)

    if not isinstance(data, dict) or "files" not in data or not isinstance(data["files"], list):
        print("Error: JSON must contain a top-level 'files' array.", file=sys.stderr)
        sys.exit(1)

    root = Path(args.root).resolve()
    created = 0
    skipped = 0

    for i, entry in enumerate(data["files"], start=1):
        if not isinstance(entry, dict):
            print(f"Skipping item {i}: not an object", file=sys.stderr)
            skipped += 1
            continue

        path = entry.get("path")
        content = entry.get("content", "")

        if not path or not isinstance(path, str):
            print(f"Skipping item {i}: missing or invalid 'path'", file=sys.stderr)
            skipped += 1
            continue

        target = (root / path).resolve()

        # Prevent writing outside the root (path traversal)
        try:
            target.relative_to(root)
        except ValueError:
            print(f"Skipping item {i}: path escapes root -> {target}", file=sys.stderr)
            skipped += 1
            continue

        target.parent.mkdir(parents=True, exist_ok=True)

        if target.exists() and not args.overwrite:
            print(f"Exists (skip): {target}", file=sys.stderr)
            skipped += 1
            continue

        # Write the file
        with open(target, "w", encoding="utf-8", newline="") as f:
            f.write(content)

        # Make JS/TS/SH files executable if they look like scripts (optional)
        if target.suffix in {".sh"} or target.name.endswith(".sh"):
            mode = target.stat().st_mode
            target.chmod(mode | 0o111)

        print(f"Wrote: {target}")
        created += 1

    print(f"Done. Created: {created}, Skipped: {skipped}")

if __name__ == "__main__":
    main()
