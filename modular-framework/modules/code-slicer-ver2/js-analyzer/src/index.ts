import path from "path";
import fs from "fs";
import fg from "fast-glob";
import { Project, Node, SyntaxKind, CallExpression, Identifier, PropertyAccessExpression, Decorator, FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression, SourceFile, ClassDeclaration, VariableDeclaration } from "ts-morph";
import { DEFAULT_IGNORES } from "./globIgnore.js";
import { writeJSON, writeText, readText, rel, coalesceRanges, normApiPath } from "./utils.js";
import type { Profile, Edges } from "./schema.js";
import { tryBabelParse } from "./babel_fallback.js";

type Args = {
  repo: string;
  out: string;
  profile?: boolean;
  context?: number;
  ["ignore-globs"]?: string[];
  ["max-files"]?: number;
  ["targets-file"]?: string;
  target?: string[];          // yargs as array
  ["api-type"]?: "http"|"function";
};

const VERBS = new Set(["get","post","put","delete","patch"]);
const JS_EXTS = ["js","jsx","ts","tsx"];

function discoverArtifacts(repo: string, ignore: string[]) {
  const openapi: string[] = [];
  const gql: string[] = [];
  const protos: string[] = [];

  const files = fg.sync(["**/*.{yaml,yml,json,graphql,gql,proto}"], {
    cwd: repo, dot: false, ignore, followSymbolicLinks: true
  });

  for (const f of files) {
    const lower = f.toLowerCase();
    if (/\.(ya?ml|json)$/.test(lower) &&
        (lower.includes("openapi") || lower.includes("swagger") || lower.endsWith("/api.yaml") || lower.endsWith("/api.yml") || lower.endsWith("/api.json"))) {
      openapi.push(f);
    } else if (/\.(graphql|gql)$/.test(lower)) {
      gql.push(f);
    } else if (lower.endsWith(".proto")) {
      protos.push(f);
    }
  }
  return { openapi, graphql: gql, grpc_protos: protos };
}

function readTargets(argv: Args): string[] {
  const t = new Set<string>();
  for (const x of argv.target || []) {
    String(x).split(",").map(s => s.trim()).filter(Boolean).forEach(y => t.add(y));
  }
  if (argv["targets-file"] && fs.existsSync(argv["targets-file"])) {
    const lines = readText(argv["targets-file"]).split(/\r?\n/).map(s => s.trim());
    for (const line of lines) if (line && !line.startsWith("#")) t.add(line);
  }
  return Array.from(t);
}

// ---------- ts-morph helpers ----------
function projectForRepo(repo: string, extraIgnore: string[]) {
  const tsconfig = path.join(repo, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfig) ? tsconfig : undefined,
    skipAddingFilesFromTsConfig: false,
    compilerOptions: { allowJs: true, checkJs: false }
  });
  if (!project.getCompilerOptions().configFilePath) {
    const files = fg.sync(["**/*.{js,jsx,ts,tsx}"], { cwd: repo, dot: false, ignore: extraIgnore });
    project.addSourceFilesAtPaths(files.map(f => path.join(repo, f)));
  }
  // touch program
  project.getSourceFiles().slice(0, 2).forEach(sf => sf.getEnd());
  return project;
}

// ---------- route detection ----------
type RouteIndex = Record<string, Set<string>>;         // path -> { nodeId }
type RouteIndexMethod = Record<string, Set<string>>;   // "METHOD /path" -> { nodeId }

function getNodeId(repo: string, fn: FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression): string | null {
  const sf = fn.getSourceFile();
  const file = rel(repo, sf.getFilePath());
  // name: function name or variable name or Class.method
  let name: string | null = null;

  if (Node.isFunctionDeclaration(fn) && fn.getName()) {
    name = fn.getName()!;
  } else if (Node.isMethodDeclaration(fn)) {
    const cls = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration) as ClassDeclaration | undefined;
    const methodName = fn.getName();
    if (cls && methodName) {
      name = `${cls.getName() || "Class"}.${methodName}`;
    }
  } else if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
    // try to find variable declarator or property name
    const v = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) as VariableDeclaration | undefined;
    if (v && v.getName()) name = v.getName();
  }
  if (!name) return null;
  return `${file}:${name}`;
}

function isStringLiteralLike(node: Node): boolean {
  return node.getKind() === SyntaxKind.StringLiteral || node.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral;
}

function textOf(node: Node): string | null {
  const k = node.getKind();
  if (k === SyntaxKind.StringLiteral) return (node as any).getLiteralText?.() ?? (node as any).getText()?.slice(1,-1);
  if (k === SyntaxKind.NoSubstitutionTemplateLiteral) return node.getText().slice(1,-1);
  return null;
}

function detectExpressRoutes(repo: string, sf: SourceFile, routes: RouteIndex, routesByMethod: RouteIndexMethod) {
  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const call = node as CallExpression;
      const ex = call.getExpression();
      if (Node.isPropertyAccessExpression(ex)) {
        const pae = ex as PropertyAccessExpression;
        const verb = pae.getName();
        if (VERBS.has(verb)) {
          const args = call.getArguments();
          if (args.length >= 1 && isStringLiteralLike(args[0])) {
            const path = normApiPath(textOf(args[0]) || "");
            // handler(s): subsequent args may be identifiers/arrow functions
            const fn = call.getArguments().find(a => Node.isIdentifier(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a)) as Node | undefined;

            let id: string | null = null;
            if (fn) {
              if (Node.isIdentifier(fn)) {
                const decs = fn.getSymbol()?.getDeclarations() || [];
                const target = decs.find(d => Node.isFunctionDeclaration(d) || Node.isFunctionExpression(d) || Node.isArrowFunction(d) || Node.isMethodDeclaration(d));
                if (target) id = getNodeId(repo, target as any);
              } else if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
                id = getNodeId(repo, fn as any);
              }
            }
            if (path) {
              routes[path] = routes[path] || new Set();
              if (id) routes[path].add(id);
              const k = `${verb.toUpperCase()} ${path}`;
              routesByMethod[k] = routesByMethod[k] || new Set();
              if (id) routesByMethod[k].add(id);
            }
          }
        }
      }
    }
  });
}

function getDecoratorName(dec: Decorator): string {
  const exp = dec.getExpression();
  if (Node.isCallExpression(exp)) {
    const e = exp.getExpression();
    return Node.isIdentifier(e) ? e.getText() : "";
  }
  if (Node.isIdentifier(exp)) return exp.getText();
  return "";
}

function getDecoratorArg(dec: Decorator): string | null {
  const exp = dec.getExpression();
  if (Node.isCallExpression(exp)) {
    const args = exp.getArguments();
    if (args.length && isStringLiteralLike(args[0])) return textOf(args[0]);
  }
  return null;
}

function detectNestRoutes(repo: string, sf: SourceFile, routes: RouteIndex, routesByMethod: RouteIndexMethod) {
  const classes = sf.getClasses();
  for (const cls of classes) {
    const ctrlDec = cls.getDecorators().find(d => getDecoratorName(d) === "Controller");
    const base = ctrlDec ? normApiPath(getDecoratorArg(ctrlDec) || "") : "";
    for (const m of cls.getMethods()) {
      const dec = m.getDecorators().find(d => {
        const n = getDecoratorName(d);
        return ["Get","Post","Put","Delete","Patch"].includes(n);
      });
      if (!dec) continue;
      const verb = getDecoratorName(dec).toUpperCase();
      const child = normApiPath(getDecoratorArg(dec) || "");
      const full = normApiPath("/" + [base, child].filter(Boolean).join("/"));
      const id = getNodeId(repo, m);
      if (id && full) {
        routes[full] = routes[full] || new Set();
        routes[full].add(id);
        const k = `${verb} ${full}`;
        routesByMethod[k] = routesByMethod[k] || new Set();
        routesByMethod[k].add(id);
      }
    }
  }
}

// ---------- function discovery & call graph ----------
function collectFunctionNodes(repo: string, sf: SourceFile) {
  const out: Array<FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression> = [];
  sf.forEachDescendant((n) => {
    if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
      out.push(n as any);
    }
  });
  return out;
}

function resolveCalleeId(repo: string, call: CallExpression): string | null {
  const expr = call.getExpression();
  let decls: Node[] = [];

  if (Node.isIdentifier(expr)) {
    decls = expr.getSymbol()?.getDeclarations() || [];
  } else if (Node.isPropertyAccessExpression(expr)) {
    // property call: foo.bar()
    const sym = expr.getSymbol() || expr.getNameNode().getSymbol();
    if (sym) decls = sym.getDeclarations() || [];
  }

  const target = decls.find(d =>
    Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d) || Node.isFunctionExpression(d) || Node.isArrowFunction(d)
  );

  if (target) {
    return getNodeId(repo, target as any);
  }
  return null;
}

function buildEdges(repo: string, files: SourceFile[]): { edges: Edges; ids: Set<string> } {
  const edges: Record<string, Set<string>> = {};
  const ids = new Set<string>();

  for (const sf of files) {
    const fns = collectFunctionNodes(repo, sf);
    for (const fn of fns) {
      const from = getNodeId(repo, fn);
      if (!from) continue;
      ids.add(from);
      edges[from] = edges[from] || new Set();

      fn.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
          const to = resolveCalleeId(repo, n as CallExpression);
          if (to) edges[from].add(to);
        }
      });
    }
  }
  return { edges, ids };
}

// ---------- graph utils ----------
function reachable(edges: Edges, roots: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of edges[cur] || []) {
      if (!seen.has(nxt)) stack.push(nxt);
    }
  }
  return seen;
}

// ---------- slicing / blocks ----------
function findFunctionLines(fn: FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression) {
  const s = fn.getStartLineNumber();
  const e = fn.getEndLineNumber();
  return [s, e] as const;
}

function extractBlocks(repo: string, files: SourceFile[], selectedIds: Set<string>, context: number) {
  // file -> ranges [s,e,[ids]]
  const byFile = new Map<string, Array<[number, number, string[]]>>();

  const idToNode = new Map<string, Node>();
  for (const sf of files) {
    sf.forEachDescendant((n) => {
      if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isFunctionExpression(n) || Node.isArrowFunction(n)) {
        const id = getNodeId(repo, n as any);
        if (id) idToNode.set(id, n);
      }
    });
  }

  for (const id of selectedIds) {
    const node = idToNode.get(id);
    if (!node) continue;
    const sf = node.getSourceFile();
    const file = rel(repo, sf.getFilePath());
    const [s0, e0] = findFunctionLines(node as any);
    const lines = sf.getLineCount();
    const s = Math.max(1, s0 - context);
    const e = Math.min(lines, e0 + context);
    const arr = byFile.get(file) || [];
    arr.push([s, e, [id]]);
    byFile.set(file, arr);
  }

  // coalesce
  for (const [file, ranges] of Array.from(byFile)) {
    byFile.set(file, coalesceRanges(ranges));
  }
  return byFile;
}

// ---------- outputs ----------
function writeGraphDot(outDir: string, edges: Edges, selected: Set<string>) {
  const lines: string[] = ['digraph Slice {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const [a, bs] of Object.entries(edges)) {
    if (!selected.has(a)) continue;
    for (const b of bs) {
      if (selected.has(b)) lines.push(`  "${a}" -> "${b}";`);
    }
  }
  lines.push("}");
  writeText(path.join(outDir, "graph.dot"), lines.join("\n"));
}

function writeRanking(outDir: string, edges: Edges, roots: Set<string>) {
  // BFS distances
  const dist = new Map<string, number>();
  const q: string[] = [];
  for (const r of roots) { dist.set(r, 0); q.push(r); }
  for (let i=0; i<q.length; i++) {
    const u = q[i];
    const du = dist.get(u)!;
    for (const v of edges[u] || []) if (!dist.has(v)) { dist.set(v, du+1); q.push(v); }
  }
  // degrees
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const [a, bs] of Object.entries(edges)) {
    outdeg.set(a, (outdeg.get(a) || 0) + (bs.size || 0));
    for (const b of bs) indeg.set(b, (indeg.get(b) || 0) + 1);
  }
  // all nodes
  const all = new Set<string>([...Object.keys(edges)]);
  for (const bs of Object.values(edges)) for (const b of bs) all.add(b);

  const rows = ["node,distance,out_degree,in_degree"];
  for (const n of Array.from(all).sort()) {
    rows.push(`${n},${dist.has(n)?dist.get(n):""},${outdeg.get(n)||0},${indeg.get(n)||0}`);
  }
  writeText(path.join(outDir, "ranked_functions.csv"), rows.join("\n"));
}

function writeSlice(repo: string, outDir: string, blocks: Map<string, Array<[number, number, string[]]>>, context: number) {
  const mdLines: string[] = [`# Code Slice (JS/TS)\n\n- Files: **${blocks.size}**\n- Context lines: **${context}**\n\n## Snippets\n`];
  const jlPath = path.join(outDir, "snippets.jsonl");
  let idx = 0;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jlPath, "", "utf8");

  for (const [file, ranges] of Array.from(blocks).sort((a,b)=>a[0].localeCompare(b[0]))) {
    const full = path.join(repo, file);
    const lines = readText(full).split(/\r?\n/);
    mdLines.push(`\n### \`${file}\`\n`);
    const lang = file.endsWith(".ts") || file.endsWith(".tsx") ? "typescript" : "javascript";

    for (const [s,e,ids] of ranges) {
      idx += 1;
      const code = lines.slice(s-1, e).join("\n");
      mdLines.push(`**Block ${idx} (lines ${s}–${e})**\n\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
      const rec = {
        index: idx,
        file,
        start_line: s,
        end_line: e,
        symbols: ids,
        language: lang,
        text: code
      };
      fs.appendFileSync(jlPath, JSON.stringify(rec) + "\n", "utf8");
    }
  }
  writeText(path.join(outDir, "slice.md"), mdLines.join("\n"));
}

function writeMeta(outDir: string, files: Iterable<string>, context: number, routesIndex: RouteIndex, roots: Set<string>) {
  const meta = {
    files: Array.from(files),
    context,
    routes: Object.fromEntries(Object.entries(routesIndex).map(([k,v]) => [k, Array.from(v)])),
    roots: Array.from(roots).sort()
  };
  writeJSON(path.join(outDir, "meta.json"), meta);
}

// ---------- main run ----------
export async function run(argv: Args) {
  const repo = path.resolve(argv.repo);
  const out = path.resolve(argv.out || "/out");
  const ignore = [...DEFAULT_IGNORES, ...(argv["ignore-globs"] || [])];
  const targets = readTargets(argv);
  const apiType = argv["api-type"] || "http";
  const context = Math.max(0, argv.context ?? 8);

  // file list (limit if requested)
  const allFiles = fg.sync(["**/*.{js,jsx,ts,tsx}"], { cwd: repo, dot: false, ignore, followSymbolicLinks: true });
  const filesLimited = argv["max-files"] ? allFiles.slice(0, argv["max-files"]) : allFiles;

  // project
  const project = projectForRepo(repo, ignore);
  let srcFiles = project.getSourceFiles().filter(sf => JS_EXTS.includes(sf.getExtension().replace(".","").toLowerCase()));
  if (argv["max-files"]) {
    const allow = new Set(filesLimited.map(f => path.join(repo, f)));
    srcFiles = srcFiles.filter(sf => allow.has(sf.getFilePath()));
  }

  // ensure parse; babel fallback sanity
  if (srcFiles.length === 0 && filesLimited[0]) tryBabelParse(readText(path.join(repo, filesLimited[0])));

  const counts = { js: srcFiles.length || allFiles.length };

  if (argv.profile) {
    // profile mode (same contract as before)
    const artifacts = discoverArtifacts(repo, ignore);
    const entrypoints: string[] = [];
    for (const f of filesLimited) {
      const base = path.basename(f).toLowerCase();
      const txt = readText(path.join(repo, f));
      if (["index.js","index.ts","server.js","server.ts","app.js","app.ts"].includes(base)
          || txt.includes("@Controller") || txt.includes("express()") || txt.includes("Router(")) {
        entrypoints.push(f);
      }
    }
    const frameworks: string[] = [];
    if (filesLimited.some(f => {
      const t = readText(path.join(repo, f));
      return t.includes("@Controller") || t.includes("express()");
    })) frameworks.push("express/nest");

    const prof: Profile = {
      repo_root: repo,
      ignore_globs_effective: ignore,
      languages: counts.js > 0 ? ["js"] : [],
      counts: { js: counts.js },
      services: [{
        name: "default",
        root: ".",
        entrypoints: Array.from(new Set(entrypoints)).sort(),
        frameworks: Array.from(new Set(frameworks)).sort(),
        http_base_prefixes: [],
        routes_index_hint: {},
        artifacts,
        javascript: {
          tsconfig: fs.existsSync(path.join(repo, "tsconfig.json")) ? "tsconfig.json" : null,
          paths: {}
        }
      }]
    };

    writeJSON(path.join(out, "profile.json"), prof);
    writeText(path.join(out, "profile.md"),
      `# Repository Profile (JS/TS)\n- Repo root: \`${prof.repo_root}\`\n- JS/TS files: ${counts.js}\n- Entrypoints: ${prof.services[0].entrypoints.join(", ")||"n/a"}\n- Frameworks: ${prof.services[0].frameworks.join(", ")||"n/a"}\`
`);
    console.log(`✅ JS profile written to ${path.join(out, "profile.json")}`);
    return;
  }

  // --- analysis mode ---
  const routes: RouteIndex = {};
  const routesByMethod: RouteIndexMethod = {};

  for (const sf of srcFiles) {
    detectExpressRoutes(repo, sf, routes, routesByMethod);
    detectNestRoutes(repo, sf, routes, routesByMethod);
  }

  const { edges, ids } = buildEdges(repo, srcFiles);

  // roots
  const roots = new Set<string>();
  if (apiType === "http") {
    const want = new Set(targets.map(normApiPath));
    for (const [p, nodes] of Object.entries(routes)) {
      if (want.has(normApiPath(p))) for (const n of nodes) if (n) roots.add(n);
    }
  } else {
    // function: match by exact id or unique suffix ":name"
    const allIds = new Set<string>(ids);
    const idList = Array.from(allIds);
    for (const t of targets) {
      if (allIds.has(t)) { roots.add(t); continue; }
      const suf = ":" + t.replace(/^.*:/, "");
      const matches = idList.filter(x => x.endsWith(suf));
      if (matches.length === 1) roots.add(matches[0]);
    }
  }

  // reachable set
  const selected = reachable(edges, roots);

  // extract blocks
  const byFile = extractBlocks(repo, srcFiles, selected, context);

  // outputs
  // graph
  writeGraphDot(out, edges, selected);
  // meta
  writeMeta(out, byFile.keys(), context, routes, roots);
  // ranked csv
  writeRanking(out, edges, roots);
  // snippets & slice.md
  writeSlice(repo, out, byFile, context);

  console.log(`✅ JS slice written to ${out}`);
}
