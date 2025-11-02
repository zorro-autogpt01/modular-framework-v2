import path from "path";
import fg from "fast-glob";
import fs from "fs";
import { Project} from "ts-morph";
import { collectRoutes, inferBasePrefixes } from "./routes";
import { firstHopCalleesForHandlers, buildProjectEdges } from "./callgraph";
import { makeIgnoreMatcher, relTo, loadTsconfigAliases, fromPackageJson, normApiPath } from "./utils";
import { extractBlocks, reachable, writeSlice, writeGraph, writeMeta, writeRanking } from "./slice";

export interface AnalyzeOptions {
  repo: string;
  out: string;
  ignoreGlobs: string[];
  maxFiles?: number;
  profileOnly?: boolean;
  targets?: string[];
  apiType?: "http"|"function";
  context?: number;
  hints?: string[];
}

export async function runAnalyze(opts: AnalyzeOptions) {
  const ignore = makeIgnoreMatcher("", opts.ignoreGlobs || []);
  const project = new Project({
    skipFileDependencyResolution: true
  });

  // Discover files
  const patterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
  const entries = await fg(patterns, { cwd: opts.repo, absolute: true, dot: true, ignore: opts.ignoreGlobs });
  if (opts.maxFiles && entries.length > opts.maxFiles) entries.length = opts.maxFiles;
  for (const abs of entries) project.addSourceFileAtPath(abs);

  // ROUTES
  const { routes, frameworks } = collectRoutes(project, opts.repo, (p: string) => ignore(p), opts.maxFiles);

  const routesByPath: Record<string, string[]> = {};
  const routesByMethod: Record<string, string[]> = {};
  const handlerIds: string[] = [];
  for (const r of routes) {
    (routesByPath[r.path] ||= []).push(r.handlerId);
    if (r.method) (routesByMethod[`${r.method} ${r.path}`] ||= []).push(r.handlerId);
    handlerIds.push(r.handlerId);
  }
  for (const k of Object.keys(routesByPath)) {
    const seen = new Set<string>();
    routesByPath[k] = routesByPath[k].filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  }
  for (const k of Object.keys(routesByMethod)) {
    const seen = new Set<string>();
    routesByMethod[k] = routesByMethod[k].filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  }

  // FIRST-HOP
  const endpointFirst = firstHopCalleesForHandlers(project, opts.repo, handlerIds);

  // PACKAGE + entrypoints
  const pkgInfo = fromPackageJson(opts.repo);
  for (const f of pkgInfo.frameworks) frameworks.add(f);
  const entrypoints = pkgInfo.entrypoints.map((p) => relTo(opts.repo, p));

  // ALIASES
  const aliases = loadTsconfigAliases(opts.repo);

  // PROFILE object
  const allPaths = Object.keys(routesByPath);
  const httpBasePrefixes = inferBasePrefixes(allPaths);

  const profile = {
    repo_root: opts.repo.replaceAll(path.sep, "/"),
    ignore_globs_effective: opts.ignoreGlobs,
    languages: entries.length ? ["js"] : [],
    counts: { js: entries.length },
    services: [
      {
        name: "default",
        root: ".",
        entrypoints,
        frameworks: Array.from(frameworks.values()).sort(),
        http_base_prefixes: httpBasePrefixes,
        routes_index_hint: Object.fromEntries(Object.entries(routesByPath)),
        routes_by_method: Object.fromEntries(Object.entries(routesByMethod)),
        artifacts: { openapi: [], graphql: [], grpc_protos: [] },
        javascript: {
          import_aliases: aliases,
          endpoint_first_callees: endpointFirst
        }
      }
    ]
  };

  // If profile-only, stop here
  if (opts.profileOnly) {
    return { profile, filesCount: entries.length };
  }

  // ---- SLICING ----
  const apiType = opts.apiType || "http";
  const targets = (opts.targets || []).map((t) => apiType === "http" ? normApiPath(t) : t);
  const context = opts.context ?? 8;
  const hints = opts.hints || [];

  // Roots: map targets -> handler ids
  const roots = new Set<string>();
  if (apiType === "http") {
    const idx = routesByPath; // path -> [handlers]
    for (const t of targets) {
      const hit = idx[t] || idx[t.replace(/\/+$/,"")] || idx[normApiPath(t)];
      if (hit) hit.forEach((h) => roots.add(h));
    }
  } else {
    // function targets: allow exact handlerId match (rel:file:Fn) or suffix match :Fn
    for (const id of handlerIds) {
      for (const t of targets) {
        if (id === t || id.endsWith(":" + t)) roots.add(id);
      }
    }
  }

  // Build edges and select reachable
  const edges = buildProjectEdges(project, opts.repo);
  const selected = reachable(edges, roots);

  // Extract blocks
  const { byFile, byHint } = extractBlocks(project, opts.repo, selected, context, hints);

  // Write outputs
  const outDir = opts.out;
  fs.mkdirSync(outDir, { recursive: true });
  writeSlice(opts.repo, outDir, byFile, byHint, context);
  writeGraph(outDir, edges, selected);
  // routesIndex for meta: use the JS subset relevant to targets (or all)
  const metaRoutes: Record<string, string[]> = routesByPath;
  writeMeta(outDir, [...byFile.keys()].map((p)=>relTo(opts.repo, p)), context, metaRoutes, Array.from(roots));
  writeRanking(outDir, edges, roots);

  return { profile, filesCount: entries.length };
}
