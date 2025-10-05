import json
import re
from typing import List, Any

RAW_OPEN = r"<#!#!#!>"
RAW_CLOSE = r"(?:</#!#!#!>|<#!#!#!>)"  # support both symmetric and explicit closing tags
RAW_BLOCK_RE = re.compile(RAW_OPEN + r"(.*?)" + RAW_CLOSE, re.S)

def escape_raw_blocks(text: str) -> str:
    """Replace <#!#!#!> ... <#!#!#!> (or </#!#!#!>) with JSON-escaped content."""
    def _sub(m):
        raw = m.group(1)
        # json.dumps gives us a quoted string; we strip the quotes because
        # the raw lives inside an existing JSON string value already.
        return json.dumps(raw)[1:-1]
    return RAW_BLOCK_RE.sub(_sub, text)

def extract_top_level_json_objects(blob: str) -> List[str]:
    """Return a list of raw JSON object strings from a mixed blob."""
    objs = []
    i = 0
    n = len(blob)
    while i < n:
        # find next '{'
        start = blob.find('{', i)
        if start == -1:
            break
        # track braces while respecting string literals
        depth = 0
        j = start
        in_str = False
        esc = False
        while j < n:
            ch = blob[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == '\\':
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        objs.append(blob[start:j+1])
                        i = j + 1
                        break
            j += 1
        else:
            # unmatched brace; stop
            break
        # continue scanning after this object
    return objs

def parse_objects_with_raw_fix(blob: str) -> List[Any]:
    """Parse all objects after fixing raw blocks inside them."""
    out = []
    for raw in extract_top_level_json_objects(blob):
        fixed = escape_raw_blocks(raw)
        try:
            out.append(json.loads(fixed))
        except json.JSONDecodeError as e:
            # optional: print or collect errors
            pass
    return out

def pick_plan(objs: List[dict]) -> dict | None:
    for o in objs:
        if isinstance(o, dict) and "version" in o and "changes" in o:
            return o
    return None

if __name__ == "__main__":
    # Example usage: read from a file or stdin
    import sys
    data = sys.stdin.read()
    objs = parse_objects_with_raw_fix(data)
    plan = pick_plan(objs)
    if plan is None:
        # fall back to output everything parsed
        print(json.dumps(objs, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
