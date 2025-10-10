#!/usr/bin/env python3
"""
Robust code change plan executor with comprehensive validation and error prevention.
"""
import argparse
import json
import os
import re
import shutil
import sys
import difflib
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List
from dataclasses import dataclass

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# ---------- Color output ----------

class Colors:
    RESET = '\033[0m'
    RED = '\033[91m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    
    @classmethod
    def disable(cls):
        cls.RESET = cls.RED = cls.GREEN = cls.YELLOW = ''
        cls.BLUE = cls.MAGENTA = cls.CYAN = ''

def info(msg: str):
    print(f"{Colors.BLUE}[INFO]{Colors.RESET} {msg}")

def warn(msg: str):
    print(f"{Colors.YELLOW}[WARN]{Colors.RESET} {msg}", file=sys.stderr)

def err(msg: str):
    print(f"{Colors.RED}[ERROR]{Colors.RESET} {msg}", file=sys.stderr)

def success(msg: str):
    print(f"{Colors.GREEN}[OK]{Colors.RESET} {msg}")

# ---------- Validation helpers ----------

@dataclass
class ValidationError:
    change_id: str
    message: str
    severity: str  # 'error' or 'warning'
    
    def __str__(self):
        prefix = f"{Colors.RED}ERROR" if self.severity == 'error' else f"{Colors.YELLOW}WARNING"
        return f"{prefix}{Colors.RESET} [{self.change_id}]: {self.message}"

class Validator:
    def __init__(self, root: Path):
        self.root = root
        self.errors: List[ValidationError] = []
        self.warnings: List[ValidationError] = []
    
    def add_error(self, change_id: str, msg: str):
        self.errors.append(ValidationError(change_id, msg, 'error'))
    
    def add_warning(self, change_id: str, msg: str):
        self.warnings.append(ValidationError(change_id, msg, 'warning'))
    
    def validate_regex(self, change_id: str, pattern: str, field_name: str) -> bool:
        """Validate a regex pattern and return True if valid."""
        if not pattern:
            self.add_error(change_id, f"{field_name}: empty pattern")
            return False
        try:
            re.compile(pattern, re.MULTILINE | re.DOTALL)
            return True
        except re.error as e:
            self.add_error(change_id, f"{field_name}: invalid regex '{pattern}': {e}")
            return False
    
    def validate_path_exists(self, change_id: str, path: Path, context: str) -> bool:
        """Check if a path exists."""
        try:
            full_path = relsafe(self.root, path)
            if not full_path.exists():
                self.add_error(change_id, f"{context}: path does not exist: {path}")
                return False
            return True
        except ValueError as e:
            self.add_error(change_id, f"{context}: {e}")
            return False
    
    def validate_anchor_exists(self, change_id: str, text: str, anchor: str, is_regex: bool) -> bool:
        """Check if an anchor exists in text."""
        if is_regex:
            try:
                if not re.search(anchor, text, re.MULTILINE | re.DOTALL):
                    self.add_warning(change_id, f"regex anchor not found in file: {anchor[:50]}...")
                    return False
            except re.error:
                return False
        else:
            if anchor not in text:
                self.add_warning(change_id, f"literal anchor not found in file: {anchor[:50]}...")
                return False
        return True
    
    def has_errors(self) -> bool:
        return len(self.errors) > 0
    
    def print_summary(self):
        if self.warnings:
            print(f"\n{Colors.YELLOW}Warnings ({len(self.warnings)}):{Colors.RESET}")
            for w in self.warnings:
                print(f"  {w}")
        
        if self.errors:
            print(f"\n{Colors.RED}Errors ({len(self.errors)}):{Colors.RESET}")
            for e in self.errors:
                print(f"  {e}")

# ---------- File helpers ----------

def ensure_parent(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)

def backup_file(p: Path) -> Optional[Path]:
    if not p.exists():
        return None
    bak = p.with_suffix(p.suffix + '.bak')
    idx = 1
    candidate = bak
    while candidate.exists():
        candidate = p.with_suffix(f"{p.suffix}.bak.{idx}")
        idx += 1
    shutil.copy2(p, candidate)
    info(f"Created backup: {candidate}")
    return candidate

def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8")

def write_text(p: Path, content: str):
    p.write_text(content, encoding="utf-8", newline="\n")

def set_mode(p: Path, mode_str: Optional[str]):
    if not mode_str:
        return
    try:
        mode = int(mode_str, 8)
        os.chmod(p, mode)
    except ValueError as e:
        warn(f"Invalid chmod mode '{mode_str}': {e}")

def relsafe(base: Path, target: Path) -> Path:
    """Resolve path relative to base, preventing directory traversal."""
    resolved = (base / target).resolve()
    base_resolved = base.resolve()
    try:
        resolved.relative_to(base_resolved)
    except ValueError:
        raise ValueError(f"Path escapes project root: {target}")
    return resolved

# ---------- Diff + confirmation ----------

def print_diff(before: str, after: str, path: Path, use_color: bool = True):
    """Print unified diff with optional color."""
    diff = list(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"{path} (before)",
        tofile=f"{path} (after)",
        lineterm=''
    ))
    
    if not diff:
        return
    
    for line in diff:
        if use_color:
            if line.startswith('+++') or line.startswith('---'):
                print(f"{Colors.CYAN}{line}{Colors.RESET}", end='')
            elif line.startswith('+'):
                print(f"{Colors.GREEN}{line}{Colors.RESET}", end='')
            elif line.startswith('-'):
                print(f"{Colors.RED}{line}{Colors.RESET}", end='')
            elif line.startswith('@@'):
                print(f"{Colors.MAGENTA}{line}{Colors.RESET}", end='')
            else:
                print(line, end='')
        else:
            print(line, end='')
        if not line.endswith('\n'):
            print()

def ask_confirm(before: str, after: str, path: Path, dry: bool, assume_yes: bool, use_color: bool = True) -> bool:
    """Show diff and ask user whether to apply."""
    if before == after:
        info(f"{path} - no changes needed")
        return False
    
    print(f"\n{Colors.CYAN}{'='*60}{Colors.RESET}")
    print(f"{Colors.CYAN}Changes for: {path}{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*60}{Colors.RESET}")
    print_diff(before, after, path, use_color)
    print(f"{Colors.CYAN}{'='*60}{Colors.RESET}\n")
    
    if dry:
        info("(dry-run mode - no changes will be applied)")
        return False
    
    if assume_yes:
        return True
    
    while True:
        resp = input(f"Apply changes to {path}? [y/N/q]: ").strip().lower()
        if resp == 'q':
            print("Aborted by user")
            sys.exit(0)
        elif resp == 'y':
            return True
        elif resp == 'n' or resp == '':
            return False
        else:
            print("Please enter 'y' (yes), 'n' (no), or 'q' (quit)")

def confirm_and_write(path: Path, before: str, after: str, dry: bool, backup: bool, assume_yes: bool, use_color: bool = True):
    """Show diff, confirm, and write if approved."""
    if ask_confirm(before, after, path, dry, assume_yes, use_color):
        if backup and path.exists():
            backup_file(path)
        write_text(path, after)
        success(f"Applied changes to {path}")
    else:
        info(f"Skipped changes to {path}")

# ---------- Patch utilities ----------

def insert_after(text: str, anchor: str, insertion: str, regex=False) -> Tuple[str, int]:
    if regex:
        m = re.search(anchor, text, flags=re.MULTILINE | re.DOTALL)
        if not m:
            return text, 0
        idx = m.end()
    else:
        idx = text.find(anchor)
        if idx == -1:
            return text, 0
        idx += len(anchor)
    return text[:idx] + insertion + text[idx:], 1

def insert_before(text: str, anchor: str, insertion: str, regex=False) -> Tuple[str, int]:
    if regex:
        m = re.search(anchor, text, flags=re.MULTILINE | re.DOTALL)
        if not m:
            return text, 0
        idx = m.start()
    else:
        idx = text.find(anchor)
        if idx == -1:
            return text, 0
    return text[:idx] + insertion + text[idx:], 1

def replace_between(text: str, start: str, end: str, repl: str, include=False) -> Tuple[str, int]:
    s = text.find(start)
    if s == -1:
        return text, 0
    e = text.find(end, s + len(start))
    if e == -1:
        return text, 0
    if include:
        return text[:s] + repl + text[e + len(end):], 1
    else:
        return text[:s + len(start)] + repl + text[e:], 1

def patch_once(text: str, p: Dict[str, Any]) -> Tuple[str, int]:
    """Apply a single patch operation."""
    t = p["type"]
    
    if t == "replace_literal":
        needle = p.get("match", "")
        replacement = p.get("replacement", "")
        if not needle:
            warn("replace_literal: empty match string")
            return text, 0
        count = p.get("count", 0) or 0
        maxcount = count if count > 0 else text.count(needle)
        applied = min(text.count(needle), maxcount if maxcount > 0 else text.count(needle))
        return text.replace(needle, replacement, maxcount), applied

    if t == "replace_regex":
        pattern = p.get("match", "")
        replacement = p.get("replacement", "")
        count = p.get("count", 0) or 0
        try:
            new_text, n = re.subn(pattern, replacement, text, count=count, flags=re.MULTILINE | re.DOTALL)
            return new_text, n
        except re.error as e:
            warn(f"replace_regex failed: {e}")
            return text, 0

    if t == "insert_after":
        anchor = p.get("anchor") or p.get("match", "")
        insertion = p.get("replacement", "")
        if p.get("newline", True) and insertion and not insertion.endswith("\n"):
            insertion += "\n"
        return insert_after(text, anchor, insertion, regex=p.get("regex", False))

    if t == "insert_before":
        anchor = p.get("anchor") or p.get("match", "")
        insertion = p.get("replacement", "")
        if p.get("newline", True) and insertion and not insertion.endswith("\n"):
            insertion += "\n"
        return insert_before(text, anchor, insertion, regex=p.get("regex", False))

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
            warn("ensure_line: empty line")
            return text, 0
        lines = text.splitlines()
        if line in lines:
            return text, 0
        if not text.endswith("\n"):
            text += "\n"
        return text + line + "\n", 1

    raise ValueError(f"Unknown patch type: {t}")

# ---------- Pre-validation of changes ----------

def validate_change(validator: Validator, change: Dict[str, Any], idx: int):
    """Validate a single change before execution."""
    change_id = change.get("id", f"change-{idx}")
    op = change.get("op")
    
    if not op:
        validator.add_error(change_id, "missing 'op' field")
        return
    
    if op == "write_file":
        if "path" not in change:
            validator.add_error(change_id, "write_file: missing 'path'")
        if "content" not in change:
            validator.add_error(change_id, "write_file: missing 'content'")
        if change.get("chmod"):
            chmod = change["chmod"]
            if not re.match(r'^[0-7]{3,4}$', chmod):
                validator.add_error(change_id, f"write_file: invalid chmod '{chmod}'")
    
    elif op == "delete_path":
        if "path" not in change:
            validator.add_error(change_id, "delete_path: missing 'path'")
        else:
            path = Path(change["path"])
            validator.validate_path_exists(change_id, path, "delete_path")
    
    elif op == "rename_path":
        if "from_path" not in change:
            validator.add_error(change_id, "rename_path: missing 'from_path'")
        if "to_path" not in change:
            validator.add_error(change_id, "rename_path: missing 'to_path'")
        if "from_path" in change:
            validator.validate_path_exists(change_id, Path(change["from_path"]), "rename_path")
    
    elif op == "patch_text":
        if "path" not in change:
            validator.add_error(change_id, "patch_text: missing 'path'")
            return
        
        path = Path(change["path"])
        if not validator.validate_path_exists(change_id, path, "patch_text"):
            return
        
        patches = change.get("patches", [])
        if not patches:
            validator.add_warning(change_id, "patch_text: no patches specified")
            return
        
        # Validate each patch
        try:
            full_path = relsafe(validator.root, path)
            text = read_text(full_path)
            
            for i, patch in enumerate(patches):
                patch_id = f"{change_id}.patch-{i+1}"
                ptype = patch.get("type")
                
                if ptype == "replace_regex" or (patch.get("regex") and ptype in ["insert_after", "insert_before"]):
                    pattern = patch.get("match") or patch.get("anchor", "")
                    validator.validate_regex(patch_id, pattern, "pattern")
                
                # Check if anchors exist
                if ptype in ["insert_after", "insert_before"]:
                    anchor = patch.get("anchor") or patch.get("match", "")
                    if anchor:
                        is_regex = patch.get("regex", False)
                        validator.validate_anchor_exists(patch_id, text, anchor, is_regex)
                
                if ptype == "replace_between":
                    start = patch.get("start")
                    end = patch.get("end")
                    if not start:
                        validator.add_error(patch_id, "replace_between: missing 'start'")
                    if not end:
                        validator.add_error(patch_id, "replace_between: missing 'end'")
                    if start and end:
                        if start not in text:
                            validator.add_warning(patch_id, f"start anchor not found: {start[:30]}...")
                        if end not in text:
                            validator.add_warning(patch_id, f"end anchor not found: {end[:30]}...")
        
        except Exception as e:
            validator.add_error(change_id, f"patch_text validation failed: {e}")
    
    elif op == "ensure_block":
        if "path" not in change:
            validator.add_error(change_id, "ensure_block: missing 'path'")
        if "block_id" not in change:
            validator.add_error(change_id, "ensure_block: missing 'block_id'")
        if "block_content" not in change:
            validator.add_error(change_id, "ensure_block: missing 'block_content'")
        
        if change.get("anchor") and change.get("regex"):
            validator.validate_regex(change_id, change["anchor"], "anchor")
    
    else:
        validator.add_error(change_id, f"unknown operation: {op}")

# ---------- Operations ----------

def op_write_file(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool, use_color: bool):
    path = relsafe(root, Path(change["path"]))
    mode = change.get("mode", "create_if_missing")
    content = change["content"]
    chmod = change.get("chmod")

    exists = path.exists()
    if mode == "create_new" and exists:
        raise FileExistsError(f"{path} already exists (mode=create_new)")
    if mode == "create_if_missing" and exists:
        info(f"write_file: {path} exists; skipping (mode=create_if_missing)")
        return

    ensure_parent(path)
    before = read_text(path) if exists else ""

    if mode == "append" and exists:
        after = before + ("" if before.endswith("\n") else "\n") + content
    elif mode == "prepend" and exists:
        after = content + ("" if content.endswith("\n") else "\n") + before
    else:
        after = content

    confirm_and_write(path, before, after, dry, backup, assume_yes, use_color)

    if not dry and chmod and path.exists():
        set_mode(path, chmod)

def op_delete_path(root: Path, change: Dict[str, Any], dry: bool, assume_yes: bool):
    path = relsafe(root, Path(change["path"]))
    recursive = change.get("recursive", False)
    
    if not path.exists():
        if change.get("if_absent", "skip") == "error":
            raise FileNotFoundError(f"{path} does not exist")
        info(f"delete_path: {path} absent; skipping")
        return

    print(f"\n{Colors.YELLOW}{'='*60}{Colors.RESET}")
    print(f"{Colors.YELLOW}Delete: {path}{Colors.RESET}")
    print(f"{Colors.YELLOW}Type: {'directory' if path.is_dir() else 'file'}{Colors.RESET}")
    if path.is_dir():
        print(f"{Colors.YELLOW}Recursive: {recursive}{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*60}{Colors.RESET}\n")
    
    if dry:
        info("(dry-run mode - no changes will be applied)")
        return
    
    if not assume_yes:
        while True:
            resp = input(f"Delete {path}? [y/N/q]: ").strip().lower()
            if resp == 'q':
                print("Aborted by user")
                sys.exit(0)
            elif resp == 'y':
                break
            elif resp == 'n' or resp == '':
                info(f"Skipped deleting {path}")
                return
            else:
                print("Please enter 'y' (yes), 'n' (no), or 'q' (quit)")
    
    if path.is_dir():
        if recursive:
            shutil.rmtree(path)
        else:
            path.rmdir()
    else:
        path.unlink()
    success(f"Deleted {path}")

def op_rename_path(root: Path, change: Dict[str, Any], dry: bool, assume_yes: bool):
    src = relsafe(root, Path(change["from_path"]))
    dst = relsafe(root, Path(change["to_path"]))
    
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist")
    if dst.exists() and not change.get("overwrite_existing", False):
        raise FileExistsError(f"{dst} exists (set overwrite_existing=true)")

    print(f"\n{Colors.CYAN}{'='*60}{Colors.RESET}")
    print(f"{Colors.CYAN}Rename/Move:{Colors.RESET}")
    print(f"  From: {src}")
    print(f"  To:   {dst}")
    print(f"{Colors.CYAN}{'='*60}{Colors.RESET}\n")
    
    if dry:
        info("(dry-run mode - no changes will be applied)")
        return
    
    if not assume_yes:
        while True:
            resp = input(f"Rename {src.name}? [y/N/q]: ").strip().lower()
            if resp == 'q':
                print("Aborted by user")
                sys.exit(0)
            elif resp == 'y':
                break
            elif resp == 'n' or resp == '':
                info(f"Skipped renaming {src}")
                return
            else:
                print("Please enter 'y' (yes), 'n' (no), or 'q' (quit)")
    
    ensure_parent(dst)
    if dst.exists():
        if dst.is_dir():
            shutil.rmtree(dst)
        else:
            dst.unlink()
    shutil.move(str(src), str(dst))
    success(f"Renamed/moved {src} -> {dst}")

def op_patch_text(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool, use_color: bool):
    path = relsafe(root, Path(change["path"]))
    if not path.exists():
        raise FileNotFoundError(f"{path} not found for patch_text")
    
    before = read_text(path)
    working = before
    total_applied = 0
    
    for i, p in enumerate(change.get("patches", []), 1):
        working, n = patch_once(working, p)
        if n > 0:
            info(f"  Patch {i}: applied {n} change(s)")
        else:
            warn(f"  Patch {i}: no changes (anchor not found or already applied)")
        total_applied += n

    if total_applied == 0:
        info(f"patch_text: {path} - no changes applied")
        return

    confirm_and_write(path, before, working, dry, backup, assume_yes, use_color)

def op_ensure_block(root: Path, change: Dict[str, Any], dry: bool, backup: bool, assume_yes: bool, use_color: bool):
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
        info(f"ensure_block: updating existing block '{bid}'")
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
                    warn(f"ensure_block: anchor regex not found, appending to end")
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
                    warn(f"ensure_block: anchor not found, appending to end")
                    new_text = before + ("\n" if before and not before.endswith("\n") else "") + block
        else:
            new_text = before + ("\n" if before and not before.endswith("\n") else "") + block
        info(f"ensure_block: inserting new block '{bid}'")

    confirm_and_write(path, before, new_text, dry, backup, assume_yes, use_color)

# ---------- Main driver ----------

def apply_change(root: Path, change: Dict[str, Any], global_dry: bool, global_backup: bool, 
                 assume_yes: bool, use_color: bool):
    """Apply a single change operation."""
    dry = bool(change.get("dry_run", global_dry))
    backup = bool(change.get("backup", global_backup))
    op = change["op"]

    try:
        if op == "write_file":
            op_write_file(root, change, dry, backup, assume_yes, use_color)
        elif op == "delete_path":
            op_delete_path(root, change, dry, assume_yes)
        elif op == "rename_path":
            op_rename_path(root, change, dry, assume_yes)
        elif op == "patch_text":
            op_patch_text(root, change, dry, backup, assume_yes, use_color)
        elif op == "ensure_block":
            op_ensure_block(root, change, dry, backup, assume_yes, use_color)
        else:
            raise ValueError(f"Unsupported op: {op}")
    except Exception as e:
        if change.get("continue_on_error", False):
            warn(f"{change.get('id', op)} failed: {e} (continuing)")
        else:
            raise

def load_plan(path: str) -> Dict[str, Any]:
    """Load plan from JSON or YAML file with helpful error messages."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
            
        # Try JSON first
        if path.endswith('.json'):
            try:
                return json.loads(content)
            except json.JSONDecodeError as e:
                err(f"JSON parse error in {path}:")
                err(f"  Line {e.lineno}, Column {e.colno}: {e.msg}")
                # Show context
                lines = content.splitlines()
                if e.lineno <= len(lines):
                    err(f"  {lines[e.lineno-1]}")
                    err(f"  {' ' * (e.colno-1)}^")
                sys.exit(2)
        
        # Try YAML
        elif path.endswith(('.yaml', '.yml')):
            if not HAS_YAML:
                err("YAML support requires PyYAML: pip install pyyaml")
                sys.exit(2)
            try:
                return yaml.safe_load(content)
            except yaml.YAMLError as e:
                err(f"YAML parse error in {path}: {e}")
                sys.exit(2)
        
        # Auto-detect
        else:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                if HAS_YAML:
                    try:
                        return yaml.safe_load(content)
                    except yaml.YAMLError as e:
                        err(f"Failed to parse as JSON or YAML: {e}")
                        sys.exit(2)
                else:
                    err("File is not valid JSON. For YAML support: pip install pyyaml")
                    sys.exit(2)
    
    except FileNotFoundError:
        err(f"Plan file not found: {path}")
        sys.exit(2)
    except Exception as e:
        err(f"Error loading plan: {e}")
        sys.exit(2)

def main():
    ap = argparse.ArgumentParser(
        description="Apply code change plans with validation and interactive confirmation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s plan.json                    # Interactive mode
  %(prog)s plan.json --validate         # Validate without applying
  %(prog)s plan.json --assume-yes       # Auto-apply all changes
  %(prog)s plan.yaml --root /path/to/project
        """
    )
    ap.add_argument("plan", help="Path to plan file (JSON or YAML)")
    ap.add_argument("--root", default=None, help="Project root (overrides plan.project_root)")
    ap.add_argument("--dry-run", action="store_true", help="Show diffs without modifying files")
    ap.add_argument("--no-backup", action="store_true", help="Do not create .bak files")
    ap.add_argument("--assume-yes", "-y", action="store_true", help="Apply all changes without prompting")
    ap.add_argument("--validate", action="store_true", help="Validate plan only, don't apply")
    ap.add_argument("--no-color", action="store_true", help="Disable colored output")
    args = ap.parse_args()

    if args.no_color or not sys.stdout.isatty():
        Colors.disable()

    # Load plan
    plan = load_plan(args.plan)

    # Check version
    version = plan.get("version")
    if version != "1.0":
        err(f"Unsupported plan version: {version}")
        sys.exit(2)

    # Determine root
    root = Path(args.root or plan.get("project_root") or ".").resolve()
    if not root.exists():
        err(f"Project root not found: {root}")
        sys.exit(2)

    # Settings
    dry = args.dry_run or plan.get("dry_run", False) or args.validate
    backup = (not args.no_backup) and plan.get("backup", True)
    assume_yes = args.assume_yes
    use_color = not args.no_color and sys.stdout.isatty()

    info(f"Project root: {root}")
    info(f"Mode: {'VALIDATE' if args.validate else 'DRY-RUN' if dry else 'APPLY'}")
    info(f"Backup: {backup} | Assume-yes: {assume_yes}")

    changes = plan.get("changes", [])
    if not changes:
        warn("No changes found in plan")
        return

    # Pre-validate all changes
    info(f"\nValidating {len(changes)} change(s)...")
    validator = Validator(root)
    for i, change in enumerate(changes, 1):
        validate_change(validator, change, i)

    validator.print_summary()

    if validator.has_errors():
        err("\nValidation failed. Fix errors before applying.")
        sys.exit(1)
    
    if args.validate:
        success("\nValidation passed!")
        return

    # Apply changes
    print(f"\n{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BLUE}Applying changes...{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*60}{Colors.RESET}\n")

    for i, change in enumerate(changes, 1):
        title = change.get("id", f"change-{i}")
        desc = change.get("description", "")
        info(f"[{i}/{len(changes)}] {title} ({change.get('op')})")
        if desc:
            print(f"  {desc}")
        
        apply_change(root, change, dry, backup, assume_yes, use_color)
        print()  # Blank line between changes

    print(f"{Colors.GREEN}{'='*60}{Colors.RESET}")
    success("Done!")
    print(f"{Colors.GREEN}{'='*60}{Colors.RESET}")

if __name__ == "__main__":
    main()