#!/usr/bin/env python3
import sys, json, re
from pathlib import Path

OP_ENUM = {"write_file","delete_path","rename_path","patch_text","ensure_block"}
MODE_ENUM = {"create_new","overwrite","append","prepend","create_if_missing"}
POSITION_ENUM = {"before","after","replace"}

def err(path, msg):
    print(f"[ERROR] {path}: {msg}")

def warn(path, msg):
    print(f"[WARN ] {path}: {msg}")

def check_change(i, ch):
    ctx = f"changes[{i}]"
    # Basic shape
    if "op" not in ch:
        err(ctx, "missing 'op'")
        return
    op = ch["op"]
    if op not in OP_ENUM:
        err(ctx, f"invalid op '{op}'")
    # additionalProperties: false (spot obvious typos)
    allowed = {
        "id","description","continue_on_error","op",
        "path","content","mode","chmod",
        "recursive","if_absent",
        "from_path","to_path","overwrite_existing",
        "patches",
        "block_id","block_content","anchor","position","regex","markers"
    }
    for k in ch.keys():
        if k not in allowed:
            warn(ctx, f"unknown property '{k}' (blocked by additionalProperties:false)")

    # Per-op requirements
    def require(*keys):
        for k in keys:
            if k not in ch:
                err(ctx, f"op '{op}' requires '{k}'")

    if op == "write_file":
        require("path","content")
        if "mode" in ch and ch["mode"] not in MODE_ENUM:
            err(ctx, f"invalid mode '{ch['mode']}'")
    elif op == "delete_path":
        require("path")
    elif op == "rename_path":
        require("from_path","to_path")
    elif op == "patch_text":
        require("path","patches")
    elif op == "ensure_block":
        require("path","block_id","block_content")
        if "position" in ch and ch["position"] not in POSITION_ENUM:
            err(ctx, f"invalid position '{ch['position']}'")

    # Type sanity checks (lightweight)
    bool_fields = {"continue_on_error","recursive","overwrite_existing","regex"}
    for bf in bool_fields:
        if bf in ch and not isinstance(ch[bf], bool):
            err(ctx, f"'{bf}' must be a boolean")

    if "chmod" in ch and not re.fullmatch(r"[0-7]{3,4}", str(ch["chmod"])):
        err(ctx, f"chmod must be 3–4 octal digits (e.g., 644, 0755)")

    # Heuristic: if writing .json, try to parse content
    path = ch.get("path","")
    if op == "write_file" and isinstance(path,str) and path.endswith(".json"):
        c = ch.get("content","")
        if not isinstance(c,str):
            err(ctx, "content must be a string")
        else:
            # Warn about likely unescaped quotes
            if '"' in c and '\\"' not in c:
                warn(ctx, "content contains raw quotes; make sure they are escaped")
            try:
                json.loads(c)
            except Exception as e:
                warn(ctx, f"content is not valid JSON for {path}: {e}")

def main():
    if len(sys.argv) < 2:
        print("Usage: plan_lint.py <plan.json>", file=sys.stderr)
        sys.exit(1)
    data = Path(sys.argv[1]).read_text(encoding="utf-8")
    try:
        plan = json.loads(data)
    except json.JSONDecodeError as e:
        print(f"[FATAL] Invalid JSON: {e}")
        sys.exit(2)

    # Top-level sanity
    for req in ("version","changes"):
        if req not in plan:
            err("$", f"missing top-level '{req}'")

    if not isinstance(plan.get("changes",None), list):
        err("$.changes", "must be an array")
    else:
        for i, ch in enumerate(plan["changes"]):
            if not isinstance(ch, dict):
                err(f"changes[{i}]", "each change must be an object")
                continue
            check_change(i, ch)

if __name__ == "__main__":
    main()
