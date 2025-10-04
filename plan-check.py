#!/usr/bin/env python3
import sys, re, json
from pathlib import Path

VALID_JSON_ESC = set(list(r'\"/bfnrt'))  # allowed after backslash in JSON (plus 'u' handled separately)

# ----------------------------
# 0) Raw preflight (regex JSON-escape issues)
# ----------------------------
REGEX_FIELD_KEYS = (r'"match"\s*:', r'"replacement"\s*:')
BAD_REGEX_ESC = re.compile(r'\\([sSdDwWbB])')        # \s, \S, \d, \D, \w, \W, \b, \B (should be \\s etc. in JSON)
BACKREF_ESC   = re.compile(r'(?<!\\)\\([1-9])')      # \1, \2 ... (suggest $1)
JSON_BAD_ESC  = re.compile(r'\\(?![\"\\/bfnrtu])')   # any \ not followed by valid JSON escape (rough heuristic)

def preflight_scan(raw: str):
    issues = []
    # Find candidate lines with "match": or "replacement":
    for m in re.finditer(rf'(?P<key>{"|".join(REGEX_FIELD_KEYS)})\s*"(?P<val>(?:[^"\\]|\\.)*)"', raw):
        key = m.group('key')
        val = m.group('val')
        pos = m.start()
        # Flags
        bad_json = [x.group(0) for x in re.finditer(JSON_BAD_ESC, val)]
        bad_regex = [x.group(0) for x in re.finditer(BAD_REGEX_ESC, val)]
        bad_backrefs = [x.group(0) for x in re.finditer(BACKREF_ESC, val)] if '"replacement"' in key else []
        if bad_json or bad_regex or bad_backrefs:
            issues.append((pos, key.strip(), val, bad_json, bad_regex, bad_backrefs))
    return issues

def preflight_autofix(raw: str):
    # Replace ONLY inside "match"/"replacement" JSON string values.
    def repl(m):
        key = m.group('key')
        val = m.group('val')
        orig = val
        # 1) Double-regex escapes commonly used (\s \S \d \D \w \W \b \B) -> \\s etc.
        val = re.sub(BAD_REGEX_ESC, lambda mm: '\\\\' + mm.group(1), val)
        # 2) Replacement backrefs: \1 -> $1 (safer across engines)
        if '"replacement"' in key:
            val = re.sub(BACKREF_ESC, lambda mm: f'${mm.group(1)}', val)
        if val == orig:
            return m.group(0)  # unchanged
        return f'{key} "{val}"'
    return re.sub(
        rf'(?P<key>{"|".join(REGEX_FIELD_KEYS)})\s*"(?P<val>(?:[^"\\]|\\.)*)"',
        repl,
        raw
    )

# ----------------------------
# 1) Inner-quote/control sanitizer (line-based)
# ----------------------------
def is_escaped(s, i):
    b = 0; j = i - 1
    while j >= 0 and s[j] == '\\':
        b += 1; j -= 1
    return (b % 2) == 1

def first_colon_outside_quotes(s):
    in_str = False
    for i, ch in enumerate(s):
        if ch == '"' and not is_escaped(s, i):
            in_str = not in_str
        if ch == ':' and not in_str:
            return i
    return -1

def last_unescaped_quote(s, start):
    last = -1
    for i in range(start, len(s)):
        if s[i] == '"' and not is_escaped(s, i):
            last = i
    return last

def escape_inner_quotes_and_controls(segment):
    # segment begins/ends with unescaped "
    out = []
    for i, ch in enumerate(segment):
        if ch == '"' and i not in (0, len(segment) - 1) and not is_escaped(segment, i):
            out.append('\\"')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        else:
            out.append(ch)
    return ''.join(out)

def fix_line(line: str) -> str:
    colon = first_colon_outside_quotes(line)
    if colon == -1:
        return line
    left = line[:colon + 1]
    right = line[colon + 1:]
    i = 0
    while i < len(right) and right[i].isspace():
        i += 1
    if i >= len(right) or right[i] != '"':
        return line
    start = colon + 1 + i
    end = last_unescaped_quote(line, start)
    if end == -1 or end == start:
        return line
    segment = line[start:end + 1]
    fixed_segment = escape_inner_quotes_and_controls(segment)
    return line[:start] + fixed_segment + line[end + 1:]

def sanitize_value_strings(text: str) -> str:
    return "\n".join(fix_line(l) for l in text.splitlines())

# ----------------------------
# 2) Lint (schema-ish) + regex checks post-parse
# ----------------------------
OP_ENUM = {"write_file","delete_path","rename_path","patch_text","ensure_block"}
MODE_ENUM = {"create_new","overwrite","append","prepend","create_if_missing"}
POSITION_ENUM = {"before","after","replace"}

def err(ctx, msg): print(f"[ERROR] {ctx}: {msg}")
def warn(ctx, msg): print(f"[WARN ] {ctx}: {msg}")

def check_change(i, ch):
    ctx = f"changes[{i}]"
    op = ch.get("op")
    if op not in OP_ENUM:
        err(ctx, f"invalid op '{op}'"); return

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

    def require(*keys):
        for k in keys:
            if k not in ch:
                err(ctx, f"op '{op}' requires '{k}'")

    if op == "write_file":
        require("path","content")
        if "mode" in ch and ch["mode"] not in MODE_ENUM:
            err(ctx, f"invalid mode '{ch['mode']}'")
        # Heuristic: JSON files inside content
        path = ch.get("path","")
        if isinstance(path,str) and path.endswith(".json"):
            c = ch.get("content","")
            if isinstance(c,str):
                try:
                    json.loads(c)
                except Exception as e:
                    warn(ctx, f"{path} content not valid JSON: {e}")

    elif op == "delete_path":
        require("path")

    elif op == "rename_path":
        require("from_path","to_path")

    elif op == "patch_text":
        require("path","patches")
        patches = ch.get("patches", [])
        if not isinstance(patches, list):
            err(ctx, "'patches' must be an array"); return
        for j, p in enumerate(patches):
            pctx = f"{ctx}.patches[{j}]"
            ptype = p.get("type")
            if ptype not in {"replace_literal","replace_regex","insert_after","insert_before","replace_between","ensure_line"}:
                err(pctx, f"invalid patch type '{ptype}'"); continue
            # Extra safety for regex-based patches
            is_regex = (ptype == "replace_regex") or bool(p.get("regex"))
            if is_regex and "match" in p and isinstance(p["match"], str):
                pat = p["match"]
                # Try compiling the pattern with Python's 're' as a sanity check
                try:
                    re.compile(pat)
                except re.error as e:
                    warn(pctx, f"regex pattern may be invalid for Python/PCRE: {e}")
                # Look for sequences that *should* have been double-escaped in JSON (they will appear as \s etc. after parsing)
                if r'\s' in pat or r'\S' in pat or r'\d' in pat or r'\D' in pat or r'\w' in pat or r'\W' in pat or r'\b' in pat or r'\B' in pat:
                    # If we got here, your JSON had "\\s" etc. which is correct. No warning.
                    pass  # keep for clarity
            if "replacement" in p and isinstance(p["replacement"], str):
                rep = p["replacement"]
                if re.search(r'\\[1-9]', rep):
                    warn(pctx, "replacement uses backrefs like \\1; prefer $1 (or escape as \\\\1)")

    elif op == "ensure_block":
        require("path","block_id","block_content")
        if "position" in ch and ch["position"] not in POSITION_ENUM:
            err(ctx, f"invalid position '{ch['position']}'")

    # Booleans
    for bf in ("continue_on_error","recursive","overwrite_existing","regex"):
        if bf in ch and not isinstance(ch[bf], bool):
            err(ctx, f"'{bf}' must be a boolean")

    # chmod
    if "chmod" in ch and not re.fullmatch(r"[0-7]{3,4}", str(ch["chmod"])):
        err(ctx, "chmod must be 3–4 octal digits (e.g., 644, 0755)")

def main():
    import argparse
    ap = argparse.ArgumentParser(description="Fix & lint CodeChangePlan JSON files.")
    ap.add_argument("input", help="plan.json")
    ap.add_argument("-o","--output", help="write fixed file here (default: stdout)")
    ap.add_argument("--fix-regex", action="store_true", help="auto-fix common regex JSON escapes and backrefs in match/replacement")
    args = ap.parse_args()

    raw = Path(args.input).read_text(encoding="utf-8")

    # A) Preflight report
    issues = preflight_scan(raw)
    for pos, key, val, bad_json, bad_regex, bad_backrefs in issues:
        where = f"offset {pos}"
        if bad_json:
            print(f"[WARN ] {where} {key} contains suspicious JSON escape(s): {', '.join(bad_json)}")
        if bad_regex:
            print(f"[WARN ] {where} {key} contains regex escapes that should be double-escaped in JSON: {', '.join(bad_regex)} (write as \\\\...)")
        if bad_backrefs:
            print(f"[WARN ] {where} {key} replacement uses backrefs like {', '.join(bad_backrefs)}; prefer $1/$2 or escape as \\\\1")

    if args.fix_regex and issues:
        raw = preflight_autofix(raw)

    # B) Sanitize value strings (inner quotes + control chars)
    sanitized = sanitize_value_strings(raw)

    # C) Parse JSON strictly
    try:
        plan = json.loads(sanitized)
    except json.JSONDecodeError as e:
        print(f"[FATAL] Invalid JSON after fixes: {e}")
        # If we auto-fixed regex, offer to write the intermediate text for debugging
        if args.output:
            Path(args.output).write_text(sanitized, encoding="utf-8")
        sys.exit(2)

    # D) Lint
    if "changes" not in plan or not isinstance(plan["changes"], list):
        err("$", "missing or invalid top-level 'changes'")
    else:
        for i, ch in enumerate(plan["changes"]):
            if isinstance(ch, dict):
                check_change(i, ch)
            else:
                err(f"changes[{i}]", "must be an object")

    # E) Write output
    if args.output:
        Path(args.output).write_text(sanitized, encoding="utf-8")
    else:
        sys.stdout.write(sanitized)

if __name__ == "__main__":
    main()
