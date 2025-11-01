#!/usr/bin/env python3
import argparse, json, subprocess, sys, shutil
from pathlib import Path

def has_js(repo: Path) -> bool:
    for ext in (".js",".jsx",".ts",".tsx"):
        if next(repo.rglob(f"*{ext}"), None) is not None:
            return True
    return False

def docker_available() -> bool:
    return shutil.which("docker") is not None

def run_container_or_local(image_or_cmd, repo: Path, out_dir: Path, args_list, local_cmd=None, env=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(image_or_cmd, str) and docker_available():
        cmd = ["docker","run","--rm","-v",f"{repo.resolve()}:/repo:ro","-v",f"{out_dir.resolve()}:/out",image_or_cmd] + args_list
    else:
        if not local_cmd:
            raise RuntimeError("No local command provided and Docker unavailable.")
        cmd = local_cmd + args_list
    print("▶", " ".join(cmd))
    res = subprocess.run(cmd, env=env)
    if res.returncode != 0:
        print(f"⚠ command exited with {res.returncode}", file=sys.stderr)
    return res.returncode

def merge_services(core_svc, js_svc):
    if not core_svc: return js_svc
    if not js_svc:   return core_svc
    merged = dict(core_svc)
    for k in ("frameworks","entrypoints","http_base_prefixes"):
        merged[k] = sorted(set(core_svc.get(k, []) + js_svc.get(k, [])))
    rih = {}
    for src in (core_svc.get("routes_index_hint", {}), js_svc.get("routes_index_hint", {})):
        for path, nodes in src.items():
            rih.setdefault(path, set()).update(nodes)
    merged["routes_index_hint"] = {k: sorted(v) for k, v in rih.items()}
    arts = {}
    for src in (core_svc.get("artifacts", {}), js_svc.get("artifacts", {})):
        for k, arr in src.items():
            arts.setdefault(k, set()).update(arr)
    merged["artifacts"] = {k: sorted(v) for k, v in arts.items()}
    for langk in ("python","javascript","graphql","grpc"):
        if core_svc.get(langk) or js_svc.get(langk):
            d = dict(core_svc.get(langk, {})); d.update(js_svc.get(langk, {})); merged[langk] = d
    # routes_by_method (optional)
    rbm = {}
    for src in (core_svc.get("routes_by_method", {}), js_svc.get("routes_by_method", {})):
        for k, arr in src.items():
            rbm.setdefault(k, set()).update(arr)
    if rbm:
        merged["routes_by_method"] = {k: sorted(v) for k, v in rbm.items()}
    return merged

def merge_profiles(core_path: Path, js_path: Path, merged_path: Path):
    def read(p):
        return json.loads(p.read_text()) if p.exists() else {}
    core = read(core_path / "profile.json")
    js   = read(js_path / "profile.json")
    if not core and not js:
        print("⚠ no profiles to merge", file=sys.stderr); return 1
    merged = {}
    merged["repo_root"] = core.get("repo_root") or js.get("repo_root")
    merged["ignore_globs_effective"] = sorted(set(core.get("ignore_globs_effective", []) + js.get("ignore_globs_effective", [])))
    merged["languages"] = sorted(set(core.get("languages", [])) | set(js.get("languages", [])))
    counts = dict(core.get("counts", {}))
    for k, v in js.get("counts", {}).items():
        counts[k] = counts.get(k, 0) + v
    merged["counts"] = counts
    core_svcs = {s.get("name","default"): s for s in core.get("services", [])}
    js_svcs   = {s.get("name","default"): s for s in js.get("services", [])}
    names = set(core_svcs) | set(js_svcs)
    merged_svcs = []
    for name in sorted(names):
        merged_svcs.append(merge_services(core_svcs.get(name), js_svcs.get(name)))
    merged["services"] = merged_svcs
    merged_path.mkdir(parents=True, exist_ok=True)
    (merged_path / "profile.json").write_text(json.dumps(merged, indent=2))
    print(f"✅ merged profile -> {merged_path/'profile.json'}")
    return 0

def merge_slices(core: Path, js: Path, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    # slice.md
    md_core = (core / "slice.md")
    md_js   = (js / "slice.md")
    md_out  = (out / "slice.md")
    parts = []
    if md_core.exists(): parts.append(md_core.read_text())
    if md_js.exists():
        if parts: parts.append("\n---\n\n# JS Snippets\n\n")
        parts.append(md_js.read_text())
    if parts:
        md_out.write_text("".join(parts), encoding="utf-8")
        print(f"🧩 merged slice.md -> {md_out}")
    # snippets.jsonl (just concatenate, indices remain local)
    sn_core = core / "snippets.jsonl"
    sn_js   = js / "snippets.jsonl"
    sn_out  = out / "snippets.jsonl"
    with sn_out.open("w", encoding="utf-8") as w:
        if sn_core.exists(): w.write(sn_core.read_text())
        if sn_js.exists():   w.write(sn_js.read_text())
    if sn_out.exists(): print(f"🧩 merged snippets.jsonl -> {sn_out}")
    # graph: optional — keep both; user can render independently
    for src, name in [(core / "graph.dot", "graph-core.dot"), (js / "graph.dot", "graph-js.dot")]:
        if src.exists(): shutil.copy2(src, out / name)
    # meta: keep both for now
    for src, name in [(core / "meta.json", "meta-core.json"), (js / "meta.json", "meta-js.json")]:
        if src.exists(): shutil.copy2(src, out / name)
    # ranking: keep both
    for src, name in [(core / "ranked_functions.csv", "ranked_functions_core.csv"),
                      (js / "ranked_functions.csv", "ranked_functions_js.csv")]:
        if src.exists(): shutil.copy2(src, out / name)
    # files/ trees: merge
    for sub in ("files", "patched"):
        src_core = core / sub
        src_js   = js / sub
        dst      = out / sub
        for src in (src_core, src_js):
            if src.exists():
                for p in src.rglob("*"):
                    if p.is_file():
                        rel = p.relative_to(src)
                        dst_path = dst / rel
                        dst_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(p, dst_path)

def main():
    ap = argparse.ArgumentParser(description="Run slicer-core and slicer-js, then merge outputs.")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--profile", action="store_true")
    args, passthrough = ap.parse_known_args()

    repo = Path(args.repo).resolve()
    out  = Path(args.out).resolve()
    out_core = out / "core"
    out_js   = out / "js"

    # Partition passthrough — forward slice flags to both; core will ignore JS automatically with your --skip-js flag.
    neutral = passthrough[:]  # both tools understand our flags

    # Run core (always), with --skip-js to avoid double JS work.
    core_args = ["--repo","/repo","--out","/out"] + (["--profile"] if args.profile else []) + neutral + ["--skip-js"]
    rc_core = run_container_or_local("slicer-core:latest", repo, out_core, core_args, local_cmd=["python3","api_code_slicer.py"])

    # Run JS if repo has js/ts
    need_js = has_js(repo)
    if need_js:
        js_args = ["--repo","/repo","--out","/out"] + (["--profile"] if args.profile else []) + neutral
        rc_js = run_container_or_local("slicer-js:latest", repo, out_js, js_args, local_cmd=["node","js-analyzer/cli.js"])
    else:
        rc_js = 0
        print("ℹ no JS/TS detected, skipping slicer-js")

    # Merge profile or slices
    if args.profile:
        merge_profiles(out_core, out_js, out)
    else:
        merge_slices(out_core, out_js, out)

    if rc_core != 0 or rc_js != 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
