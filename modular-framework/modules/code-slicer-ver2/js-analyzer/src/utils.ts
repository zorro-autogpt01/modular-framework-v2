import path from "path";
import fs from "fs";
import { Minimatch } from "minimatch";

export type IgnoreMatcher = (p: string) => boolean;

export function makeIgnoreMatcher(repoRoot: string, globs: string[]): IgnoreMatcher {
  const mm = globs.map((g) => new Minimatch(g, { dot: true, nocase: true, noglobstar: false, nocomment: true }));
  return (p: string) => {
    const rel = path.posix.normalize(p.replaceAll(path.sep, "/"));
    return mm.some((m) => m.match(rel));
  };
}

export function relTo(root: string, abs: string): string {
  const rel = path.relative(root, abs).replaceAll(path.sep, "/");
  return rel.startsWith("..") ? abs.replaceAll(path.sep, "/") : rel;
}

// For src/index.ts compatibility
export function rel(root: string, abs: string): string {
  return relTo(root, abs);
}

export function readJsonSafe<T = any>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return undefined;
  }
}

export function readText(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

export function writeJSON(p: string, o: any) {
  fs.writeFileSync(p, JSON.stringify(o, null, 2), "utf-8");
}

export function writeText(p: string, s: string) {
  fs.writeFileSync(p, s, "utf-8");
}

export function normApiPath(p: string | undefined | null): string {
  if (!p) return "/";
  let out = p.trim();
  if (!out.startsWith("/")) out = "/" + out;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function safePush<K extends string, V>(map: Record<K, V[]>, k: K, v: V) {
  (map[k] ||= []).push(v);
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function tryRead(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
}

export function guessEntryPoints(repo: string): string[] {
  const cands = [
    "src/main.ts","src/main.js","src/server.ts","src/server.js",
    "server.ts","server.js","index.ts","index.js","app.ts","app.js"
  ];
  return cands.filter((f) => fileExists(path.join(repo, f)));
}

export function fromPackageJson(repo: string): { frameworks: string[]; entrypoints: string[] } {
  const pkg = readJsonSafe<any>(path.join(repo, "package.json")) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frameworks: string[] = [];
  if (deps["express"]) frameworks.push("express");
  if (deps["@nestjs/core"]) frameworks.push("nest");
  if (deps["koa"] || deps["@koa/router"]) frameworks.push("koa");
  if (deps["fastify"]) frameworks.push("fastify");
  if (deps["next"]) frameworks.push("next");
  const entrypoints: string[] = [];
  if (pkg.main) entrypoints.push(relTo(repo, path.join(repo, pkg.main)));
  entrypoints.push(...guessEntryPoints(repo));
  return { frameworks: uniq(frameworks), entrypoints: uniq(entrypoints) };
}

export function loadTsconfigAliases(repo: string): Record<string, string> {
  const tsCfgPath = ["tsconfig.json", "tsconfig.base.json"]
    .map((f) => path.join(repo, f))
    .find((p) => fileExists(p));
  if (!tsCfgPath) return {};
  const cfg = readJsonSafe<any>(tsCfgPath);
  const out: Record<string, string> = {};
  const baseUrl: string | undefined = cfg?.compilerOptions?.baseUrl;
  const paths: Record<string, string[] | string> = cfg?.compilerOptions?.paths || {};
  for (const [k, v] of Object.entries(paths)) {
    const key = k.replace(/\/\*$/, "");
    const arr = Array.isArray(v) ? v : [v];
    const first = arr[0] || "";
    const val = first.replace(/\/\*$/, "");
    const rooted = baseUrl ? path.join(baseUrl, val) : val;
    out[key] = rooted.replaceAll(path.sep, "/");
  }
  return out;
}

export function isProbablyRouterFactory(src: string): boolean {
  return /express\.Router\s*\(|require\(['"]express['"]\)\.Router\s*\(/.test(src);
}

export function coalesceRanges(ranges: Array<[number, number, string[]]>): Array<[number, number, string[]]> {
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
