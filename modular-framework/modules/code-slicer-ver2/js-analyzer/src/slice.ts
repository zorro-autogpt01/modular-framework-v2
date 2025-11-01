
import fs from "fs";
import path from "path";
import {
  Project, Node, SyntaxKind, SourceFile,
  FunctionDeclaration, MethodDeclaration, FunctionExpression,
  ArrowFunction as MorphArrowFunction
} from "ts-morph";
import { relTo } from "./utils";

export type Edges = Record<string, Set<string>>;
type FnLike = FunctionDeclaration | MethodDeclaration | FunctionExpression | MorphArrowFunction;

export function reachable(edges: Edges, roots: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const u = stack.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    const outs = edges[u] || new Set<string>();
    for (const v of outs) if (!seen.has(v)) stack.push(v);
  }
  return seen;
}

function coalesceRanges(ranges: Array<[number, number, string[]]>): Array<[number, number, string[]]> {
  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number, string[]]> = [];
  for (const [s, e, syms] of ranges) {
    if (!out.length || s > out[out.length - 1][1] + 1) {
      out.push([s, e, [...syms]]);
    } else {
      const last = out[out.length - 1];
      last[1] = Math.max(last[1], e);
      for (const sym of syms) if (!last[2].includes(sym)) last[2].push(sym);
    }
  }
  return out;
}

function getLines(p: string): string[] {
  return fs.readFileSync(p, "utf-8").split(/\r?\n/);
}

export function extractBlocks(
  project: Project,
  repoRoot: string,
  nodes: Set<string>,
  context: number,
  hints: string[]
) {
  const byFile = new Map<string, Array<[number, number, string[]]>>();
  const byHint = new Map<string, Array<[number, number, string]>>();

  // map from id -> function node
  const sfCache = new Map<string, SourceFile>();

  function findFnById(id: string): FnLike | undefined {
    const [fileRel, tag] = [id.split(":")[0], id.split(":").slice(1).join(":")];
    const sf = (sfCache.get(fileRel) || project.getSourceFile((s) => s.getFilePath().endsWith(fileRel)));
    if (!sf) return undefined;
    sfCache.set(fileRel, sf);

    const fns: FnLike[] = [];
    sf.forEachDescendant((n: Node) => {
      if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isFunctionExpression(n) || Node.isArrowFunction(n)) {
        fns.push(n as FnLike);
      }
    });

    // Named match?
    const named = tag.match(/:([A-Za-z$_][\w$.]*)$/)?.[1];
    if (named) {
      for (const fn of fns) {
        if (Node.isFunctionDeclaration(fn) && fn.getName() === named) return fn;
        if (Node.isMethodDeclaration(fn)) {
          const cls = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
          const owner = cls?.getName() ? `${cls.getName()}.${fn.getName()}` : fn.getName();
          if (owner === named || fn.getName() === named) return fn;
        }
        const vd = fn.getParent()?.getParent();
        if (vd && Node.isVariableDeclaration(vd) && vd.getName() === named) return fn;
      }
    }
    // anon by line
    const m = tag.match(/#L(\d+)C(\d+)/);
    if (m) {
      const line = Number(m[1]);
      for (const fn of fns) {
        const lc = sf.getLineAndColumnAtPos(fn.getPos());
        if (lc.line === line) return fn;
      }
    }
    return undefined;
  }

  for (const id of nodes) {
    const [fileRel] = id.split(":");
    const abs = path.join(repoRoot, fileRel);
    const fn = findFnById(id);
    if (!fn || !fs.existsSync(abs)) continue;

    const start = fn.getStartLineNumber();
    const end = fn.getEndLineNumber();
    const s = Math.max(1, start - context);
    const e = end + context;
    const arr = byFile.get(abs) || [];
    arr.push([s, e, [id]]);
    byFile.set(abs, arr);
  }

  // hints
  if (hints.length) {
    for (const [abs] of byFile) {
      const lines = getLines(abs);
      const hits: Array<[number, number, string]> = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (hints.some((h) => ln.toLowerCase().includes(h.toLowerCase()))) {
          const s = Math.max(1, i + 1 - context);
          const e = Math.min(lines.length, i + 1 + context);
          hits.push([s, e, ln.trim()]);
        }
      }
      // coalesce hints
      hits.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number, string]> = [];
      for (const [s, e, txt] of hits) {
        if (!merged.length || s > merged[merged.length - 1][1] + 1) merged.push([s, e, txt]);
        else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      }
      if (merged.length) byHint.set(abs, merged);
    }
  }

  // coalesce per file
  for (const [abs, ranges] of [...byFile]) {
    byFile.set(abs, coalesceRanges(ranges));
  }

  return { byFile, byHint };
}

export function writeSlice(
  repoRoot: string,
  outDir: string,
  blocks: Map<string, Array<[number, number, string[]]>>,
  hintBlocks: Map<string, Array<[number, number, string]>>,
  context: number
) {
  fs.mkdirSync(outDir, { recursive: true });
  const md = path.join(outDir, "slice.md");
  const jl = path.join(outDir, "snippets.jsonl");

  let idx = 0;
  const mdParts: string[] = [];
  const jParts: string[] = [];

  mdParts.push(`# Code Slice\n\n- Files: **${blocks.size}**\n- Context lines: **${context}**\n\n## Snippets\n\n`);

  const entries = [...blocks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [abs, ranges] of entries) {
    const rel = relTo(repoRoot, abs);
    const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
    mdParts.push(`### \`${rel}\`\n\n`);
    for (const [s, e, syms] of ranges) {
      idx += 1;
      const code = lines.slice(s - 1, e).join("\n");
      const lang =
        abs.endsWith(".ts") || abs.endsWith(".tsx") ? "typescript" :
        abs.endsWith(".js") || abs.endsWith(".jsx") ? "javascript" : "";

      mdParts.push(`**Block ${idx} (lines ${s}–${e})**\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
      jParts.push(JSON.stringify({
        index: idx,
        file: rel,
        start_line: s,
        end_line: e,
        symbols: syms,
        language: lang || "text",
        text: code
      }));
    }
  }

  if (hintBlocks.size) {
    mdParts.push(`\n## Hint Matches\n\n`);
    const hints = [...hintBlocks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [abs, ranges] of hints) {
      const rel = relTo(repoRoot, abs);
      const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
      mdParts.push(`### \`${rel}\`\n\n`);
      for (const [s, e, ln] of ranges) {
        idx += 1;
        const code = lines.slice(s - 1, e).join("\n");
        mdParts.push(`_match: \`${ln}\`_\n\n\`\`\`text\n${code}\n\`\`\`\n\n`);
        jParts.push(JSON.stringify({
          index: idx,
          file: rel,
          start_line: s,
          end_line: e,
          hint_match: ln,
          text: code
        }));
      }
    }
  }

  fs.writeFileSync(md, mdParts.join(""), "utf-8");
  fs.writeFileSync(jl, jParts.join("\n") + (jParts.length ? "\n" : ""), "utf-8");
}

export function writeGraph(outDir: string, edges: Edges, selected: Set<string>) {
  const dot = path.join(outDir, "graph.dot");
  const parts: string[] = [];
  parts.push(`digraph Slice {\n  rankdir=LR;\n  node [shape=box, fontname="Helvetica"];\n`);
  for (const [a, bs] of Object.entries(edges)) {
    if (!selected.has(a)) continue;
    for (const b of bs) if (selected.has(b)) {
      parts.push(`  "${a}" -> "${b}";\n`);
    }
  }
  parts.push("}\n");
  fs.writeFileSync(dot, parts.join(""), "utf-8");
}

export function writeMeta(outDir: string, files: string[], context: number, routesIndex: Record<string, string[]>, roots: string[]) {
  const meta = {
    files,
    context,
    routes: routesIndex,
    roots: roots.sort()
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

export function writeRanking(outDir: string, edges: Edges, roots: Set<string>) {
  const dist = new Map<string, number>();
  const q: string[] = [];
  for (const r of roots) { dist.set(r, 0); q.push(r); }
  while (q.length) {
    const u = q.shift()!;
    const d = dist.get(u)!;
    for (const v of (edges[u] || new Set<string>())) {
      if (!dist.has(v)) { dist.set(v, d + 1); q.push(v); }
    }
  }
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const [a, bs] of Object.entries(edges)) {
    outdeg.set(a, bs.size);
    for (const b of bs) indeg.set(b, (indeg.get(b) || 0) + 1);
  }
  const allnodes = new Set<string>([...Object.keys(edges), ...Object.values(edges).flatMap((s) => [...s])]);
  const csv = ["node,distance,out_degree,in_degree"];
  for (const n of [...allnodes].sort()) {
    csv.push(`${n},${dist.has(n) ? dist.get(n) : ""},${outdeg.get(n) || 0},${indeg.get(n) || 0}`);
  }
  fs.writeFileSync(path.join(outDir, "ranked_functions.csv"), csv.join("\n"), "utf-8");
}