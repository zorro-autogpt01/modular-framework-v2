#!/usr/bin/env python3
import json, sys, re, base64
from pathlib import Path

def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""

def write_bytes(p: Path, b: bytes):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b)

def apply_edit_step(text: str, step: dict):
    """Return (new_text, matches_applied). matches_applied is used for 'strict'."""
    act = step["action"]

    if act == "replace":
        match, repl = step["match"], step.get("replacement", "")
        if step.get("regex"):
            new, n = re.subn(match, repl, text, flags=re.MULTILINE | re.DOTALL)
            return new, n
        n = text.count(match)
        return text.replace(match, repl), n

    if act in ("insert_after", "insert_before"):
        match, repl = step["match"], step.get("replacement", "")
        if step.get("regex"):
            m = re.search(match, text, flags=re.MULTILINE | re.DOTALL)
            if not m:
                # not found -> append only if not strict
                return (text + repl if not step.get("strict") else text), 0
            i = m.end() if act == "insert_after" else m.start()
            return text[:i] + repl + text[i:], 1
        i = text.find(match)
        if i == -1:
            return (text + repl if not step.get("strict") else text), 0
        i = i + len(match) if act == "insert_after" else i
        return text[:i] + repl + text[i:], 1

    if act == "delete_match":
        match = step["match"]
        if step.get("regex"):
            new, n = re.subn(match, "", text, flags=re.MULTILINE | re.DOTALL)
            return new, n
        n = text.count(match)
        return text.replace(match, ""), n

    if act == "delete_between":
        start, end = step["start"], step["end"]
        if step.get("regex"):
            pat = re.compile(f"({start}).*?({end})", re.MULTILINE | re.DOTALL)
            new, n = pat.subn("", text)
            return new, n
        # literal, remove all non-overlapping ranges
        out, i, n = [], 0, 0
        while True:
            s = text.find(start, i)
            if s == -1:
                out.append(text[i:]); break
            e = text.find(end, s + len(start))
            if e == -1:
                out.append(text[i:]); break
            out.append(text[i:s])
            i = e + len(end)
            n += 1
        return "".join(out), n

    if act == "ensure_line":
        line = step["line"].rstrip("\n")
        lines = text.splitlines()
        if line in lines:
            return (text if text.endswith("\n") else text + "\n"), 0
        lines.append(line)
        new = "\n".join(lines) + "\n"
        return new, 1

    raise ValueError(f"unknown action {act}")

def main():
    if len(sys.argv) < 2:
        print("usage: apply_min_changes.py plan.json [root=.]", file=sys.stderr)
        sys.exit(2)

    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(plan.get("root", "."))

    for i, ch in enumerate(plan["changes"], 1):
        op = ch["op"]

        if op == "mkdir":
            (root / ch["path"]).mkdir(parents=True, exist_ok=True)
            print(f"[ok] #{i} mkdir {ch['path']}")

        elif op == "write":
            enc = ch.get("encoding", "utf-8")
            raw = ch.get("content", "")
            data = base64.b64decode(raw) if enc == "base64" else raw.encode("utf-8")
            p = root / ch["path"]
            write_bytes(p, data)
            print(f"[ok] #{i} write {ch['path']} ({len(data)} bytes)")

        elif op == "edit":
            p = root / ch["path"]
            text = read_text(p)
            for step in ch["steps"]:
                text2, n = apply_edit_step(text, step)
                if step.get("strict") and n == 0:
                    raise RuntimeError(f"#{i} edit strict failure: no match for {step['action']} in {ch['path']}")
                text = text2
            write_bytes(p, text.encode("utf-8"))
            print(f"[ok] #{i} edit {ch['path']}")

        elif op == "rename":
            src = root / ch["from"]
            dst = root / ch["to"]
            overwrite = ch.get("overwrite", False)
            if not src.exists():
                raise FileNotFoundError(f"rename: source not found: {ch['from']}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists() and not overwrite:
                raise FileExistsError(f"rename: destination exists: {ch['to']} (set overwrite:true)")
            # Path.replace() overwrites if exists (atomic on same filesystem)
            src.replace(dst)
            print(f"[ok] #{i} rename {ch['from']} -> {ch['to']}")

        else:
            raise ValueError(f"unknown op {op}")

if __name__ == "__main__":
    from pathlib import Path
    main()
