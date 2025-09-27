#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import sys
import difflib
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

# ---------- helpers ----------

def info(msg: str):
    print(f"[INFO] {msg}")

def warn(msg: str):
    print(f"[WARN] {msg}", file=sys.stderr)

def err(msg: str):
    print(f"[ERROR] {msg}", file=sys.stderr)

def ensure_parent(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)

def backup_file(p: Path):
    if not p.exists():
        return None
    bak = p.with_name(f".{p.name}.bak")
    idx = 1
    candidate = bak
    while candidate.exists():
        candidate = p.with_name(f".{p.name}.bak.{idx}")
        idx += 1
    shutil.copy2(p, candidate)
    return candidate

def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8")

def write_text(p: Path, content: str):
    p.write_text(content, encoding="utf-8", newline="\n")

def set_mode(p: Path, mode_str: Optional[str]):
    if not mode_str:
        return
    mode = int(mode_str, 8)
    os.chmod(p, mode)

def relsafe(base: Path, target: Path) -> Path:
    resolved = (base / target).resolve()
    base_resolved = base.resolve()
    if not str(resolved).startswith(str(base_resolved)):
        raise ValueError(f"Path escapes project root: {target}")
    return resolved

# ---------- diff + confirmation ----------

def print_diff(before: str, after: str, path: Path):
    diff = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"{path} (before)",
        tofile=f"{path} (after)"
    )
    sys.stdout.writelines(diff)

def ask_confirm(before: str, after: str, path: Path, dry: bool, assume_yes: bool) -> bool:
    """Show diff and ask user whether to apply."""
    if before == after:
        info(f"{path} unchanged (no diff)")
        return False
    print_diff(before, after, path)
    if dry:
        return False
    if assume_yes:
        return True
    resp = input(f"Apply changes to {path}? [y/N]: ").strip().lower()
    return resp == "y"

def confirm_and_write(path: Path, before: str, after: str, dry: bool, backup: bool, assume_yes: bool):
    if ask_confirm(before, after, path, dry, assume_yes):
        if backup and path.exists():
            backup_file(path)
        write_text(path, after)
        info(f"Applied changes to {path}")
    else:
        info(f"Skipped changes to {path}")

# ---------- patch utilities ----------

def insert_after(text: str, anchor: str, insertion: str, regex=False) -> Tuple[str, int]:
    if regex:
        m = re.search(anchor, text, flags=re.MULTILINE | re.DOTALL)
        if not m: return text, 0
        idx = m.end()
    else:
        idx = text.find(anchor)
        if idx == -1: return text, 0
        idx += len(anchor)
    return text[:idx] + insertion + text[idx:], 1

def insert_before(text: str, anchor: str, insertion: str, regex=False) -> Tuple[str, int]:
    if regex:
        m = re.search(anchor, text, flags=re.MULTILINE | re.DOTALL)
        if not m: return text, 0
        idx = m.start()
    else:
        idx = text.find(anchor)
        if idx == -1: return text, 0
    return text[:idx] + insertion + text[idx:], 1

def replace_between(text: str, start: str, end: str, repl: str, include=False) -> Tuple[str, int]:
    s = text.find(start)
    if s == -1: return text, 0
    e = text.find(end, s + len(start))
    if e == -1: return text, 0
    if include:
        return text[:s] + repl + text[e + len(end):], 1
    else:
        return text[:s + len(start)] + repl + text[e:], 1

def patch_once(text: str, p: Dict[str, Any]) -> Tuple[str, int]:
    t = p["type"]
    if t == "replace_literal":
        needle = p.get("match", "")
        replacement = p.get("replacement", "")
        if not needle:
            return text, 0
        count = p.get("count", 0) or 0  # 0 means all
        maxcount = count if count > 0 else text.count(needle)
        applied = 1 if needle in text else 0
        return text.replace(needle, replacement, maxcount), applied

    if t == "replace_regex":
        pattern = p.get("match", "")
        replacement = p.get("replacement", "")
        count = p.get("count", 0) or 0
        new_text, n = re.subn(pattern, replacement, text, count=count, flags=re.MULTILINE | re.DOTALL)
        return new_text, n

    if t == "insert_after":
        anchor = p.get("anchor") or p.get("match", "")
        insertion = p.get("replacement", "")
        if p.get("newline", True) and insertion and not insertion.endswith("\n"):
            insertion += "\n"
        return insert_after(text, anchor, insertion, regex=False)

    if t == "insert_before":
        anchor = p.get("anchor") or p.get("match", "")
        insertion = p.get("replacement", "")
        if p.get("newline", True) and insertion and not insertion.endswith("\n"):
            insertion += "\n"
        return insert_before(text, anchor, insertion, regex=False)

    if t == "replace_between":
        start = p.get("start")
        end = p.get("end")
        replacement = p.get("replacement", "")
        if replacement and p.get("newline", True) and not replacement.endswith("\n"):
            replacement += "\n"
        return replace_between(text, start, end, replacement, include=p.get("include_anchors", False))

    if t == "ensure_line":
        line = p.get("match", "")
        if not line:
            return text, 0
        lines = text.splitlines()
        if line in lines:
            return text, 0
        if not text.endswith("\n"):
            text += "\n"
        return text + line + "\n", 1

    raise ValueError(f"Unknown patch type: {t}")

# ---------- operations (with confirmation) ----------

def op_write_file(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool):
    path = relsafe(root, Path(change["path"]))
    mode = change.get("mode", "create_if_missing")
    content = change["content"]
    chmod = change.get("chmod")

    exists = path.exists()
    if mode == "create_new" and exists:
        raise FileExistsError(f"{path} already exists")
    if mode == "create_if_missing" and exists:
        info(f"write_file: {path} exists; skipping")
        return

    ensure_parent(path)
    before = read_text(path) if exists else ""

    if mode == "append" and exists:
        after = before + ("" if before.endswith("\n") else "\n") + content
    elif mode == "prepend" and exists:
        after = content + ("" if content.endswith("\n") else "\n") + before
    else:
        after = content

    confirm_and_write(path, before, after, dry, backup, assume_yes)

    if not dry and chmod:
        set_mode(path, chmod)

def op_delete_path(root: Path, change: Dict[str, Any], dry: bool, assume_yes: bool):
    path = relsafe(root, Path(change["path"]))
    recursive = change.get("recursive", False)
    if not path.exists():
        if change.get("if_absent", "skip") == "error":
            raise FileNotFoundError(f"{path} does not exist")
        info(f"delete_path: {path} absent; skipping")
        return

    before = f"(exists: {'dir' if path.is_dir() else 'file'})\n"
    after = "(deleted)\n"
    # Use same confirm mechanism
    if ask_confirm(before, after, path, dry, assume_yes):
        if dry:
            info(f"(dry) would delete {path}")
            return
        if path.is_dir():
            if recursive:
                shutil.rmtree(path)
            else:
                path.rmdir()
        else:
            path.unlink()
        info(f"Deleted {path}")
    else:
        info(f"Skipped deleting {path}")

def op_rename_path(root: Path, change: Dict[str, Any], dry: bool, assume_yes: bool):
    src = relsafe(root, Path(change["from_path"]))
    dst = relsafe(root, Path(change["to_path"]))
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist")
    if dst.exists() and not change.get("overwrite_existing", False):
        raise FileExistsError(f"{dst} exists (set overwrite_existing=true to replace)")

    before = f"{src} -> {dst} (pending)\n"
    after = f"{src} -> {dst} (applied)\n"
    if ask_confirm(before, after, Path(str(src)+" -> "+str(dst)), dry, assume_yes):
        if dry:
            info(f"(dry) would rename/move {src} -> {dst}")
            return
        ensure_parent(dst)
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        shutil.move(str(src), str(dst))
        info(f"Renamed/moved {src} -> {dst}")
    else:
        info(f"Skipped renaming {src}")

def op_patch_text(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool):
    path = relsafe(root, Path(change["path"]))
    if not path.exists():
        raise FileNotFoundError(f"{path} not found for patch_text")
    before = read_text(path)

    working = before
    total_applied = 0
    for p in change.get("patches", []):
        working, n = patch_once(working, p)
        total_applied += n

    if total_applied == 0:
        info(f"patch_text: {path} no changes applied")
        return

    confirm_and_write(path, before, working, dry, backup, assume_yes)

def op_ensure_block(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool):
    path = relsafe(root, Path(change["path"]))
    bid = change["block_id"]
    content = change["block_content"]
    markers = change.get("markers", {})
    start = markers.get("start", "<!-- BEGIN:{id} -->").replace("{id}", bid)
    end = markers.get("end", "<!-- END:{id} -->").replace("{id}", bid)

    if not path.exists():
        ensure_parent(path)
        before = ""
    else:
        before = read_text(path)

    if start in before and end in before:
        new_text, _ = replace_between(before, start, end, "\n" + content.rstrip("\n") + "\n", include=False)
    else:
        anchor = change.get("anchor")
        position = change.get("position", "after")
        regex = change.get("regex", False)
        block = f"{start}\n{content.rstrip()}\n{end}\n"
        if anchor:
            if regex:
                m = re.search(anchor, before, flags=re.MULTILINE | re.DOTALL)
                if m:
                    idx = m.start() if position == "before" else m.end()
                    new_text = before[:idx] + block + before[idx:]
                else:
                    new_text = before + ("\n" if before and not before.endswith("\n") else "") + block
            else:
                idx = before.find(anchor)
                if idx != -1:
                    if position == "before":
                        new_text = before[:idx] + block + before[idx:]
                    elif position == "replace":
                        new_text = before[:idx] + block + before[idx + len(anchor):]
                    else:
                        new_text = before[:idx + len(anchor)] + block + before[idx + len(anchor):]
                else:
                    new_text = before + ("\n" if before and not before.endswith("\n") else "") + block
        else:
            new_text = before + ("\n" if before and not before.endswith("\n") else "") + block

    confirm_and_write(path, before, new_text, dry, backup, assume_yes)

# ---------- driver ----------

def apply_change(root: Path, change: Dict[str, Any], global_dry: bool, global_backup: bool, assume_yes: bool):
    dry = bool(change.get("dry_run", global_dry))
    backup = bool(change.get("backup", global_backup))
    op = change["op"]

    try:
        if op == "write_file":
            op_write_file(root, change, dry, backup, assume_yes)
        elif op == "delete_path":
            op_delete_path(root, change, dry, assume_yes)
        elif op == "rename_path":
            op_rename_path(root, change, dry, assume_yes)
        elif op == "patch_text":
            op_patch_text(root, change, dry, backup, assume_yes)
        elif op == "ensure_block":
            op_ensure_block(root, change, dry, backup, assume_yes)
        else:
            raise ValueError(f"Unsupported op: {op}")
    except Exception as e:
        if change.get("continue_on_error", False):
            warn(f"{change.get('id', op)} failed: {e} (continuing)")
        else:
            raise

def main():
    ap = argparse.ArgumentParser(description="Apply JSON code change plans (with confirmation diffs)")
    ap.add_argument("plan", help="Path to plan.json")
    ap.add_argument("--root", default=None, help="Project root (overrides plan.project_root)")
    ap.add_argument("--dry-run", action="store_true", help="Show diffs, do not modify files")
    ap.add_argument("--no-backup", action="store_true", help="Do not create backups")
    ap.add_argument("--assume-yes", action="store_true", help="Apply without prompting (CI mode)")
    args = ap.parse_args()

    with open(args.plan, "r", encoding="utf-8") as f:
        plan = json.load(f)

    version = plan.get("version")
    if version != "1.0":
        err(f"Unsupported plan version: {version}")
        sys.exit(2)

    root = Path(args.root or plan.get("project_root") or ".").resolve()
    if not root.exists():
        err(f"Project root not found: {root}")
        sys.exit(2)

    dry = args.dry_run or plan.get("dry_run", False)
    backup = (not args.no_backup) and plan.get("backup", True)
    assume_yes = args.assume_yes

    info(f"Project root: {root}")
    info(f"Dry-run: {dry} | Backup: {backup} | Assume-yes: {assume_yes}")

    changes = plan.get("changes", [])
    if not changes:
        warn("No changes found in plan")
        return

    for i, change in enumerate(changes, 1):
        title = change.get("id", f"change-{i}")
        info(f"==> {i}/{len(changes)} {title} ({change.get('op')})")
        apply_change(root, change, dry, backup, assume_yes)

    info("Done.")

if __name__ == "__main__":
    main()
