import path from "path";
import fs from "fs";
import fg from "fast-glob";
import {
  Project, Node, SyntaxKind, SourceFile, CallExpression, Identifier, PropertyAccessExpression,
  VariableDeclaration, FunctionDeclaration, MethodDeclaration, ClassDeclaration,
  ExportedDeclarations, Symbol as TsSymbol, FunctionExpression, ArrowFunction as MorphArrowFunction
} from "ts-morph";
import { IgnoreMatcher, normApiPath, relTo, safePush, uniq } from "./utils";

export interface RouteHit {
  method: string;       // GET/POST/etc or "" for unknown
  path: string;         // normalized path
  handlerId: string;    // "rel/file.ts:Fn" or "rel/file.ts:#LxCy-<anon>"
}

export interface RouteIndex {
  byPath: Record<string, string[]>;
  byMethod: Record<string, string[]>;
  frameworks: Set<string>;
}

type RouterMount = { base: string; symbol: TsSymbol };
type FnLike = FunctionDeclaration | MethodDeclaration | FunctionExpression | MorphArrowFunction;
function isHttpVerb(name: string) {
  return /^(get|post|put|delete|patch|options|head|all)$/i.test(name);
}

function anonName(sf: SourceFile, fn: MorphArrowFunction | FunctionDeclaration | MethodDeclaration, tag = "<anon>")  {
  const pos = fn.getPos();
  const { line, column } = sf.getLineAndColumnAtPos(pos);
  const rel = sf.getFilePath();
  const id = `#L${line}C${column}-${tag}`;
  return `${rel}:${id}`;
}

function fnName(sf: SourceFile, fn: FnLike)  {
  if (Node.isFunctionDeclaration(fn) && fn.getName()) {
    return `${sf.getFilePath()}:${fn.getName()}`;
  }
  if (Node.isMethodDeclaration(fn)) {
    const cls = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration) as ClassDeclaration | undefined;
    const nm = fn.getName ? fn.getName() : "method";
    const owner = cls?.getName() ? `${cls.getName()}.${nm}` : nm;
    return `${sf.getFilePath()}:${owner}`;
  }
  if (Node.isVariableDeclaration(fn.getParent()?.getParent() as any)) {
    const vd = fn.getParent()?.getParent() as VariableDeclaration;
    const nm = vd.getName();
    return `${sf.getFilePath()}:${nm}`;
  }
  // arrow/anon fallback
  return anonName(sf, fn as any);
}

function getLastHandlerArg(ce: CallExpression): Node | undefined {
  const args = ce.getArguments();
  if (args.length === 0) return undefined;
  // some frameworks have (path, ...handlers), we take the last handler-like arg
  const reversed = [...args].reverse();
  for (const a of reversed) {
    if (Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a)) return a;
    if (Node.isIdentifier(a)) return a;
    if (Node.isPropertyAccessExpression(a)) return a;
  }
  return args[args.length - 1];
}

function resolveIdentifierToFunction(sf: SourceFile, idOrPa: Identifier | PropertyAccessExpression): FnLike | undefined {
  // direct variable/function in same file
  if (Node.isIdentifier(idOrPa)) {
    const ds = idOrPa.getDefinitions();
    for (const d of ds) {
      const dn = d.getDeclarationNode();
      if (!dn) continue;
      if (Node.isFunctionDeclaration(dn)) return dn;
      if (Node.isVariableDeclaration(dn)) {
        const init = dn.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init as any;
      }
      if (Node.isMethodDeclaration(dn)) return dn;
    }
  } else {
    // property access like obj.method — try to resolve symbol to a method declaration
    const sym = idOrPa.getSymbol() || idOrPa.getNameNode().getSymbol();
    const decs = sym?.getDeclarations() || [];
    const md = decs.find(Node.isMethodDeclaration) as MethodDeclaration | undefined;
    if (md) return md;
    const fd = decs.find(Node.isFunctionDeclaration) as FunctionDeclaration | undefined;
    if (fd) return fd;
  }
  return undefined;
}

export function collectRoutes(project: Project, repoRoot: string, ignore: IgnoreMatcher, maxFiles?: number): { routes: RouteHit[]; frameworks: Set<string>; filesScanned: number } {
  const srcFiles: SourceFile[] = [];
  for (const sf of project.getSourceFiles()) {
    const abs = sf.getFilePath();
    const rel = relTo(repoRoot, abs);
    if (ignore(rel)) continue;
    srcFiles.push(sf);
  }
  const limit = typeof maxFiles === "number" ? Math.max(0, maxFiles) : Number.POSITIVE_INFINITY;

  const frameworks = new Set<string>();
  const routes: RouteHit[] = [];
  const routerVarsByFile = new Map<SourceFile, TsSymbol[]>();   // router symbols in file
  const mountsByFile = new Map<SourceFile, RouterMount[]>();    // app.use('/base', routerSym)

  let scanned = 0;

  function noteRoute(method: string, p: string, handlerId: string) {
    routes.push({ method, path: normApiPath(p), handlerId });
  }

  for (const sf of srcFiles) {
    if (scanned >= limit) break;
    scanned++;

    // Quick pre-scan for router factories to mark file as "express-ish"
    if (/express|@nestjs\/common|koa|fastify|next/.test(sf.getText())) {
      // noop; we’ll detect frameworks per call below
    }

    // Detect router variables (Express)
    const routers: TsSymbol[] = [];
    sf.forEachDescendant((n) => {
      if (Node.isCallExpression(n)) {
        const txt = n.getExpression().getText();
        if (/Router\s*\(/.test(txt)) {
          const vd = n.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
          const sym = vd?.getNameNode().getSymbol();
          if (sym) routers.push(sym);
        }
      }
    });
    if (routers.length) routerVarsByFile.set(sf, routers);

    // Detect app.use('/base', router)
    const mounts: RouterMount[] = [];
    sf.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      const expr = n.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== "use") return;

      const args = n.getArguments();
      if (args.length < 1) return;

      const first = args[0];
      const second = args[1];
      if (first && Node.isStringLiteral(first) && second && (Node.isIdentifier(second) || Node.isPropertyAccessExpression(second))) {
        const sym = (Node.isIdentifier(second) ? second.getSymbol() : second.getNameNode().getSymbol());
        if (sym && (routerVarsByFile.get(sf) || []).some((s) => s === sym)) {
          mounts.push({ base: normApiPath(first.getLiteralValue()), symbol: sym });
          frameworks.add("express");
        }
      }
    });
    if (mounts.length) mountsByFile.set(sf, mounts);

    // Collect generic routes (Express/Koa/Fastify style): obj.METHOD('/p', ..., handler)
    sf.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      const expr = n.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      const method = expr.getName();
      const args = n.getArguments();
      if (!isHttpVerb(method)) {
        // Fastify route object: fastify.route({ method, url, handler })
        if (expr.getName() === "route" && args[0] && Node.isObjectLiteralExpression(args[0])) {
          const ol = args[0];
          const mProp = ol.getProperty("method");
          const uProp = ol.getProperty("url");
          const hProp = ol.getProperty("handler");
          const m = (mProp && Node.isPropertyAssignment(mProp) && mProp.getInitializer()?.getText().replace(/['"`]/g, "")) || "";
          const u = (uProp && Node.isPropertyAssignment(uProp) && uProp.getInitializer()?.getText().replace(/['"`]/g, "")) || "";
          const hInit = hProp && Node.isPropertyAssignment(hProp) ? (hProp.getInitializer() as Node) : undefined;
          if (u && hInit) {
            frameworks.add("fastify");
            let handlerId = "";
            if (Node.isIdentifier(hInit) || Node.isPropertyAccessExpression(hInit)) {
              const fn = resolveIdentifierToFunction(sf, hInit as any);
              handlerId = fn ? fnName(sf, fn) : `${sf.getFilePath()}:${hInit.getText()}`;
            } else if (Node.isArrowFunction(hInit) || Node.isFunctionExpression(hInit)) {
              handlerId = anonName(sf, hInit as any);
            }
            noteRoute(m.toUpperCase(), u, handlerId || anonName(sf, n as any, "<handler>"));
          }
        }
        return;
      }

      const firstArg = args[0];
      if (!firstArg || !Node.isStringLiteral(firstArg)) return;
      const p = firstArg.getLiteralValue();

      const h = getLastHandlerArg(n);
      let handlerId = "";
      if (!h) {
        handlerId = `${sf.getFilePath()}:<unknown>`;
      } else if (Node.isIdentifier(h) || Node.isPropertyAccessExpression(h)) {
        const fn = resolveIdentifierToFunction(sf, h as any);
        handlerId = fn ? fnName(sf, fn) : `${sf.getFilePath()}:${h.getText()}`;
      } else if (Node.isArrowFunction(h) || Node.isFunctionExpression(h)) {
        handlerId = anonName(sf, h as any);
      } else {
        handlerId = anonName(sf, n as any, "<handler>");
      }

      // Mounted router base?
      const base = (mountsByFile.get(sf) || []).find((m) => {
        // Greedy heuristic: if this call sits textually after a mount and belongs to the same router var.
        const recv = (expr.getExpression().getSymbol && expr.getExpression().getSymbol()) || undefined;
        return recv && m.symbol === recv;
      })?.base;

      const full = base ? path.posix.join(base, p) : p;

      // Framework inference
      const recvText = expr.getExpression().getText();
      if (/fastify/i.test(recvText)) frameworks.add("fastify");
      if (/router/i.test(recvText) || /app/i.test(recvText)) frameworks.add("express");
      if (/koa/i.test(sf.getText())) frameworks.add("koa");

      noteRoute(method.toUpperCase(), full, handlerId);
    });

    // NestJS (@Controller + @Get/Post Method)
    sf.getClasses().forEach((cls) => {
      const cDecos = cls.getDecorators().map((d) => d.getText());
      const ctrl = cDecos.find((t) => /^@Controller/.test(t));
      if (!ctrl) return;
      const m = ctrl.match(/Controller\s*\(\s*['"`]([^'"`)]*)['"`]\s*\)/);
      const base = normApiPath((m && m[1]) || "/");
      frameworks.add("nest");

      cls.getMethods().forEach((md) => {
        const d = md.getDecorators().map((x) => x.getText()).find((t) => /^@(Get|Post|Put|Delete|Patch)\b/.test(t));
        if (!d) return;
        const dm = d.match(/^@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`)]*)?['"`]?\s*\)/);
        const verb = (dm?.[1] || "").toUpperCase();
        const child = normApiPath(dm?.[2] || "/");
        const full = path.posix.join(base, child);
        const handlerId = fnName(sf, md);
        noteRoute(verb, full, handlerId);
      });
    });

    // Next.js API routes:
    //  - pages/api/** -> export default handler or named methods
    //  - app/**/route.{ts,js} -> export const GET/POST/...
    const fileRel = relTo(repoRoot, sf.getFilePath());
    if (fileRel.startsWith("pages/api/")) {
      // pages router: export default function handler OR named export handlers per method (Next 13+ allows both in app router)
      const defExp = sf.getDefaultExportSymbol();
      if (defExp) {
        const decs = defExp.getDeclarations();
        const fn = decs.find(Node.isFunctionDeclaration) as FunctionDeclaration | undefined;
        if (fn) noteRoute("", "/" + fileRel.replace(/^pages\/api/, "").replace(/\.(t|j)sx?$/, ""), fnName(sf, fn));
      }
      // named exports like export const GET = (req,res)=>{}
      ["GET", "POST", "PUT", "DELETE", "PATCH"].forEach((mth) => {
        const sym = sf.getExportSymbols().find(s => s.getName() === mth);
        if (sym) {
          const decs = sym.getDeclarations();
          const vd = decs.find(Node.isVariableDeclaration) as VariableDeclaration | undefined;
          const init = vd?.getInitializer();
          if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            const p = "/" + fileRel.replace(/^pages\/api/, "").replace(/\.(t|j)sx?$/, "");
            noteRoute(mth, p, anonName(sf, init as any));
          }
        }
      });
      frameworks.add("next");
    }
    if (/\/app\/.*\/route\.(t|j)sx?$/.test(fileRel)) {
      const routeFolder = "/" + fileRel.replace(/^.*\/app\//, "").replace(/\/route\.(t|j)sx?$/, "");
      ["GET", "POST", "PUT", "DELETE", "PATCH"].forEach((mth) => {
        const sym = sf.getExportSymbols().find(s => s.getName() === mth);
        if (!sym) return;
        const decs = sym.getDeclarations();
        const vd = decs.find(Node.isVariableDeclaration) as VariableDeclaration | undefined;
        const init = vd?.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          noteRoute(mth, routeFolder ? `/${routeFolder}` : "/", anonName(sf, init as any));
        }
      });
      frameworks.add("next");
    }
  }

  // Consolidate
  const byPath: Record<string, string[]> = {};
  const byMethod: Record<string, string[]> = {};
  for (const r of routes) {
    const rel = relTo(repoRoot, r.handlerId.split(":")[0]);
    const id = `${rel}:${r.handlerId.split(":").slice(1).join(":")}`;
    (byPath[r.path] ||= []).push(id);
    if (r.method) (byMethod[`${r.method} ${r.path}`] ||= []).push(id);
  }

  // dedup + stable order
  for (const k of Object.keys(byPath)) byPath[k] = uniq(byPath[k]);
  for (const k of Object.keys(byMethod)) byMethod[k] = uniq(byMethod[k]);

  return { routes, frameworks, filesScanned: scanned, };
}

export function inferBasePrefixes(paths: string[], topK = 3): string[] {
  const c: Record<string, number> = {};
  for (const p of paths) {
    if (!p.startsWith("/")) continue;
    const parts = p.split("/").filter(Boolean);
    if (!parts.length) continue;
    const base = "/" + parts[0];
    c[base] = (c[base] || 0) + 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, topK).map(([k]) => k);
}
