#!/usr/bin/env python3
# apply_code_change_plan.py
# Literal-only implementation of your CodeChangePlan (version 1.0)

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Optional, Tuple, List

PLAN_VERSION = "1.0"

# --------------- Utilities ---------------

def fail(msg: str) -> None:
    raise RuntimeError(msg)

def read_text_utf8(path: Path) -> Tuple[str, str]:
    """
    Returns (text_with_normalized_lf, original_line_ending)
    original_line_ending: '\n' or '\r\n' (dominant) used when writing back.
    """
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        fail(f"File not found: {path}")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"File is not valid UTF-8: {path}")

    # Detect dominant line ending
    crlf = text.count("\r\n")
    lf = text.count("\n")
    # If CRLF are present and more than half of all line breaks, prefer CRLF
    dom = "\r\n" if (crlf > 0 and crlf >= (lf - crlf)) else "\n"

    # Normalize to LF for processing
    text_norm = text.replace("\r\n", "\n")
    return text_norm, dom

def write_text_preserving_eol(path: Path, text_norm: str, dom_eol: str) -> None:
    if dom_eol == "\r\n":
        out = text_norm.replace("\n", "\r\n")
    else:
        out = text_norm
    path.write_text(out, encoding="utf-8")

def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

def normalize_and_validate_target(project_root: Path, rel: str) -> Path:
    # POSIX-style is expected in the plan; still normalize/resolve safely.
    # Prevent escape from project_root.
    rel_path = Path(*rel.split("/"))  # treat as POSIX pieces
    full = (project_root / rel_path).resolve()
    try:
        full.relative_to(project_root.resolve())
    except ValueError:
        fail(f"Path escapes project_root: {rel}")
    return full

def make_backup_if_needed(target: Path, made_backup: set, enable_backup: bool, dry_run: bool) -> None:
    if not enable_backup or target in made_backup or not target.exists():
        return
    bak = target.with_suffix(target.suffix + ".bak")
    # Avoid overwriting an existing .bak
    if dry_run:
        print(f"DRY-RUN: would create backup {bak}")
    else:
        if bak.exists():
            # generate unique
            i = 1
            while True:
                nb = target.with_suffix(target.suffix + f".bak.{i}")
                if not nb.exists():
                    bak = nb
                    break
                i += 1
        ensure_parent(bak)
        shutil.copy2(target, bak)
        print(f"Backup created: {bak}")
    made_backup.add(target)

def valid_chmod_string(s: str) -> bool:
    # Accept 'xyz' or '0xyz' or '----' style is *not* supported here; keep it strict octal digits only.
    # (You can relax if you want '---' symbolic modes. For now, stick to octal digits.)
    if not s:
        return False
    if all(ch in "01234567" for ch in s) and (len(s) in (3,4)):
        return True
    return False

def apply_mode(path: Path, chmod_str: Optional[str], dry_run: bool) -> None:
    if not chmod_str:
        return
    if not valid_chmod_string(chmod_str):
        fail("Invalid chmod string.")
    mode = int(chmod_str, 8)
    if dry_run:
        print(f"DRY-RUN: would chmod {oct(mode)} {path}")
    else:
        os.chmod(path, mode)
        print(f"chmod {oct(mode)} {path}")

# --------------- Patch primitives (literal-only) ---------------

def replace_literal(buf: str, match: str, replacement: str, count: int) -> str:
    if match == "":
        return buf  # avoid infinite loop
    replaced = 0
    i = 0
    out = []
    mlen = len(match)
    blen = len(buf)
    while i <= blen - mlen:
        if buf[i:i+mlen] == match and (count == 0 or replaced < count):
            out.append(replacement)
            i += mlen
            replaced += 1
        else:
            out.append(buf[i])
            i += 1
    out.append(buf[i:])
    return "".join(out)

def insert_after(buf: str, anchor: str, replacement: str, count: int) -> str:
    if anchor == "":
        return buf
    out = []
    i = 0
    a = anchor
    alen = len(a)
    n = 0
    while i < len(buf):
        j = buf.find(a, i)
        if j == -1 or (count != 0 and n >= count):
            out.append(buf[i:])
            break
        # copy through end of anchor
        out.append(buf[i:j + alen])
        out.append(replacement)
        i = j + alen
        n += 1
    return "".join(out)

def insert_before(buf: str, anchor: str, replacement: str, count: int) -> str:
    if anchor == "":
        return buf
    out = []
    i = 0
    a = anchor
    alen = len(a)
    n = 0
    while i < len(buf):
        j = buf.find(a, i)
        if j == -1 or (count != 0 and n >= count):
            out.append(buf[i:])
            break
        # insert before anchor
        out.append(buf[i:j])
        out.append(replacement)
        out.append(a)
        i = j + alen
        n += 1
    return "".join(out)

def replace_between(buf: str, start: str, end: str, replacement: str, include_anchors: bool, count: int) -> str:
    if start == "" or end == "":
        return buf
    out = []
    i = 0
    n = 0
    while i < len(buf):
        s = buf.find(start, i)
        if s == -1 or (count != 0 and n >= count):
            out.append(buf[i:])
            break
        e_search_start = s + len(start)
        e = buf.find(end, e_search_start)
        if e == -1:
            fail("Unbalanced region: start found without subsequent end.")
        if include_anchors:
            # replace [s, e+len(end))
            out.append(buf[i:s])
            out.append(replacement)
            i = e + len(end)
        else:
            # keep anchors, replace between
            out.append(buf[i:s + len(start)])
            out.append(replacement)
            i = e  # we'll append end anchor on next loop copy
        n += 1
    return "".join(out)

def ensure_line(buf: str, line: str, newline: bool) -> str:
    # Normalize to LF lines
    lines = buf.split("\n")
    if any(l == line for l in lines):
        return buf
    appended = line + ("\n" if newline else "")
    if buf == "":
        return appended
    # Ensure there is exactly one newline at EOF if newline is requested
    if not buf.endswith("\n") and newline:
        return buf + "\n" + appended
    return buf + appended

# --------------- ensure_block ---------------

def interpolate_markers(markers: dict, block_id: str) -> Tuple[str, str]:
    start = markers.get("start", "<!-- BEGIN:{id} -->").replace("{id}", block_id)
    end = markers.get("end", "<!-- END:{id} -->").replace("{id}", block_id)
    return start, end

def ensure_block_apply(buf: str, block_id: str, block_content: str,
                       markers: dict, anchor: Optional[str], position: str) -> str:
    start_marker, end_marker = interpolate_markers(markers, block_id)

    # find existing block
    s = buf.find(start_marker)
    if s != -1:
        e_search_start = s + len(start_marker)
        e = buf.find(end_marker, e_search_start)
        if e == -1:
            fail("Corrupted block: unmatched marker.")
        # Replace inner content only
        before = buf[:e_search_start]
        after = buf[e:]
        # ensure a newline just after start_marker if you want; here we use content as-is
        inner = block_content
        # ensure a newline boundary if that's desired; keep literal behavior
        return before + ("\n" if (not inner.startswith("\n") and before and not before.endswith("\n")) else "") + inner + after

    # build block when absent
    block_text = start_marker
    # add newline after start if not present and content doesn't start with \n
    if not block_content.startswith("\n"):
        block_text += "\n"
    block_text += block_content
    # ensure newline before end marker if content doesn't end with \n and previous char not \n
    if not block_text.endswith("\n"):
        block_text += "\n"
    block_text += end_marker

    # place by anchor/position or append
    if anchor:
        j = buf.find(anchor)
        if j != -1:
            if position == "after":
                insert_at = j + len(anchor)
                return buf[:insert_at] + block_text + buf[insert_at:]
            elif position == "before":
                return buf[:j] + block_text + buf[j:]
            elif position == "replace":
                return buf[:j] + block_text + buf[j+len(anchor):]
            else:
                fail(f"Invalid position: {position}")

    # append to EOF with a separating newline if needed
    if buf and not buf.endswith("\n"):
        return buf + "\n" + block_text
    return buf + block_text

# --------------- Operations ---------------

def op_write_file(change: dict, root: Path, dry_run: bool, backup: bool, backups_done: set) -> None:
    path = normalize_and_validate_target(root, change["path"])
    mode = change.get("mode", "create_if_missing")
    content = change.get("content", "")
    chmod_str = change.get("chmod")

    exists = path.exists()
    if mode == "create_new" and exists:
        fail(f"File exists: {path}")
    if mode == "create_if_missing" and exists:
        print(f"Skip (exists): {path}")
        return

    if exists:
        make_backup_if_needed(path, backups_done, backup, dry_run)

    ensure_parent(path)
    if dry_run:
        print(f"DRY-RUN: write_file {mode} -> {path}")
    else:
        if mode in ("overwrite", "create_new", "create_if_missing"):
            path.write_text(content, encoding="utf-8")
        elif mode == "append":
            with path.open("a", encoding="utf-8") as f:
                f.write(content)
        elif mode == "prepend":
            prev = path.read_text(encoding="utf-8") if exists else ""
            path.write_text(content + prev, encoding="utf-8")
        else:
            fail(f"Unknown mode: {mode}")
        print(f"Wrote: {path}")

    apply_mode(path, chmod_str, dry_run)

def op_delete_path(change: dict, root: Path, dry_run: bool) -> None:
    path = normalize_and_validate_target(root, change["path"])
    recursive = change.get("recursive", False)
    if_absent = change.get("if_absent", "skip")

    if not path.exists():
        if if_absent == "skip":
            print(f"Skip delete (absent): {path}")
            return
        else:
            fail(f"Path not found: {path}")

    if path.is_dir():
        if recursive:
            if dry_run:
                print(f"DRY-RUN: rmtree {path}")
            else:
                shutil.rmtree(path)
                print(f"Deleted dir tree: {path}")
        else:
            # delete only if empty
            if any(path.iterdir()):
                fail("Directory not empty.")
            if dry_run:
                print(f"DRY-RUN: rmdir {path}")
            else:
                path.rmdir()
                print(f"Deleted dir: {path}")
    else:
        if dry_run:
            print(f"DRY-RUN: unlink {path}")
        else:
            path.unlink()
            print(f"Deleted file: {path}")

def op_rename_path(change: dict, root: Path, dry_run: bool) -> None:
    src = normalize_and_validate_target(root, change["from_path"])
    dst = normalize_and_validate_target(root, change["to_path"])
    overwrite = change.get("overwrite_existing", False)

    if not src.exists():
        fail(f"Source not found: {src}")
    if dst.exists() and not overwrite:
        fail("Target exists.")

    ensure_parent(dst)
    if dry_run:
        print(f"DRY-RUN: rename {src} -> {dst}")
    else:
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        src.replace(dst)  # atomic within same filesystem
        print(f"Renamed: {src} -> {dst}")

def op_patch_text(change: dict, root: Path, dry_run: bool, backup: bool, backups_done: set) -> None:
    path = normalize_and_validate_target(root, change["path"])
    text, dom = read_text_utf8(path)
    original = text

    for p in change.get("patches", []):
        ptype = p["type"]
        if ptype == "replace_literal":
            text = replace_literal(
                text,
                p.get("match", ""),
                p.get("replacement", ""),
                p.get("count", 0),
            )
        elif ptype == "insert_after":
            text = insert_after(
                text,
                p.get("anchor", ""),
                p.get("replacement", ""),
                p.get("count", 1),
            )
        elif ptype == "insert_before":
            text = insert_before(
                text,
                p.get("anchor", ""),
                p.get("replacement", ""),
                p.get("count", 1),
            )
        elif ptype == "replace_between":
            text = replace_between(
                text,
                p.get("start", ""),
                p.get("end", ""),
                p.get("replacement", ""),
                p.get("include_anchors", False),
                p.get("count", 1),
            )
        elif ptype == "ensure_line":
            text = ensure_line(
                text,
                p.get("match", ""),
                p.get("newline", True),
            )
        else:
            fail(f"Unsupported patch type in literal mode: {ptype}")

    if text != original:
        make_backup_if_needed(path, backups_done, backup, dry_run)
        if dry_run:
            print(f"DRY-RUN: write patched text -> {path}")
        else:
            write_text_preserving_eol(path, text, dom)
            print(f"Patched: {path}")
    else:
        print(f"No changes: {path}")

def op_ensure_block(change: dict, root: Path, dry_run: bool, backup: bool, backups_done: set) -> None:
    path = normalize_and_validate_target(root, change["path"])
    text, dom = read_text_utf8(path)
    original = text

    block_id = change["block_id"]
    block_content = change.get("block_content", "")
    markers = change.get("markers", {})
    anchor = change.get("anchor")
    position = change.get("position", "after")

    text = ensure_block_apply(text, block_id, block_content, markers, anchor, position)

    if text != original:
        make_backup_if_needed(path, backups_done, backup, dry_run)
        if dry_run:
            print(f"DRY-RUN: write ensured block -> {path}")
        else:
            write_text_preserving_eol(path, text, dom)
            print(f"Ensured block: {path}")
    else:
        print(f"No changes (block already up-to-date): {path}")

# --------------- Runner ---------------

def apply_change(change: dict, root: Path, dry_run: bool, backup: bool) -> None:
    cid = change.get("id", "")
    desc = change.get("description", "")
    header = f"- op={change.get('op')} id={cid}"
    if desc:
        header += f" :: {desc}"
    print(header)

    backups_done: set = set()  # one backup per file per change
    op = change["op"]
    if op == "write_file":
        op_write_file(change, root, dry_run, backup, backups_done)
    elif op == "delete_path":
        op_delete_path(change, root, dry_run)
    elif op == "rename_path":
        op_rename_path(change, root, dry_run)
    elif op == "patch_text":
        op_patch_text(change, root, dry_run, backup, backups_done)
    elif op == "ensure_block":
        op_ensure_block(change, root, dry_run, backup, backups_done)
    else:
        fail(f"Unsupported op: {op}")

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Apply literal-only CodeChangePlan v1.0")
    parser.add_argument("plan", help="Path to plan JSON file")
    parser.add_argument("--root", help="Project root override (defaults to plan.project_root or CWD)")
    parser.add_argument("--dry-run", action="store_true", help="Do not write, just show actions")
    parser.add_argument("--no-backup", action="store_true", help="Disable .bak creation")
    args = parser.parse_args(argv)

    plan_path = Path(args.plan).resolve()
    if not plan_path.exists():
        print(f"Plan file not found: {plan_path}", file=sys.stderr)
        return 2

    with plan_path.open("r", encoding="utf-8") as f:
        plan = json.load(f)

    if plan.get("version") != PLAN_VERSION:
        print(f"Unsupported plan version: {plan.get('version')}, expected {PLAN_VERSION}", file=sys.stderr)
        return 2

    project_root = Path(args.root or plan.get("project_root", os.getcwd())).resolve()
    dry_run = bool(args.dry_run or plan.get("dry_run", False))
    backup = not args.no_backup and bool(plan.get("backup", True))

    print(f"Project root: {project_root}")
    print(f"Dry run: {dry_run}")
    print(f"Backup: {backup}")
    print("-----")

    try:
        for ch in plan.get("changes", []):
            apply_change(ch, project_root, dry_run, backup)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print("Done.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
