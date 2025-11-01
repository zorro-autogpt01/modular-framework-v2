import {
  Node, SourceFile, FunctionLikeDeclaration, CallExpression, Identifier,
  PropertyAccessExpression, Project, SyntaxKind, VariableDeclaration, ClassDeclaration
} from "ts-morph";
import { relTo, uniq } from "./utils.js";

function isFunctionLike(n: Node): n is FunctionLikeDeclaration {
  return Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n);
}

function resolveCalleeToFunction(n: Identifier | PropertyAccessExpression): FunctionLikeDeclaration | undefined {
  const sym = (Node.isIdentifier(n) ? n.getSymbol() : n.getNameNode().getSymbol());
  const decs = sym?.getDeclarations() || [];
  return decs.find(isFunctionLike) as FunctionLikeDeclaration | undefined;
}

export function idForFn(sf: SourceFile, fn: FunctionLikeDeclaration): string {
  if (Node.isFunctionDeclaration(fn) && fn.getName()) return `${sf.getFilePath()}:${fn.getName()}`;
  if (Node.isMethodDeclaration(fn)) {
    const cls = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration) as ClassDeclaration | undefined;
    const nm = fn.getName() || "method";
    const owner = cls?.getName() ? `${cls.getName()}.${nm}` : nm;
    return `${sf.getFilePath()}:${owner}`;
  }
  const pos = fn.getPos();
  const { line, column } = sf.getLineAndColumnAtPos(pos);
  return `${sf.getFilePath()}:#L${line}C${column}-<anon>`;
}

export function firstHopCalleesForHandlers(project: Project, repoRoot: string, handlerIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const byFile = new Map<string, string[]>();
  for (const id of handlerIds) {
    const [fileRel] = id.split(":");
    byFile.set(fileRel, [...(byFile.get(fileRel) || []), id]);
  }

  for (const [fileRel, ids] of byFile) {
    const sf = project.getSourceFile((p) => p.endsWith(fileRel));
    if (!sf) continue;
    const allFns: FunctionLikeDeclaration[] = [];
    sf.forEachDescendant((n) => { if (isFunctionLike(n)) allFns.push(n); });

    function findFnById(id: string): FunctionLikeDeclaration | undefined {
      const tag = id.split(":").slice(1).join(":");
      const named = tag.match(/:([A-Za-z$_][\w$.]*)$/)?.[1];
      if (named) {
        const nm = named;
        const cand = allFns.find((fn) => {
          if (Node.isFunctionDeclaration(fn) && fn.getName() === nm) return true;
          if (Node.isMethodDeclaration(fn)) {
            const cls = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
            const owner = cls?.getName() ? `${cls.getName()}.${fn.getName()}` : fn.getName();
            return owner === nm || fn.getName() === nm;
          }
          const vd = fn.getParent()?.getParent();
          if (vd && Node.isVariableDeclaration(vd) && vd.getName() === nm) return true;
          return false;
        });
        if (cand) return cand;
      }
      const m = tag.match(/#L(\d+)C(\d+)/);
      if (m) {
        const line = Number(m[1]);
        return allFns.find((fn) => sf.getLineAndColumnAtPos(fn.getPos()).line === line);
      }
      return undefined;
    }

    for (const id of ids) {
      const fn = findFnById(id);
      if (!fn) continue;
      const callees: string[] = [];

      fn.forEachDescendant((n) => {
        if (!Node.isCallExpression(n)) return;
        const expr = n.getExpression();
        if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
          const target = resolveCalleeToFunction(expr);
          if (target) {
            const sf2 = target.getSourceFile();
            const label = `${relTo(repoRoot, sf2.getFilePath())}:${idForFn(sf2, target).split(":").slice(1).join(":")}`;
            callees.push(label);
          } else {
            const ds = (Node.isIdentifier(expr) ? expr.getDefinitions() : expr.getNameNode().getDefinitions());
            for (const d of ds || []) {
              const dn = d.getDeclarationNode();
              if (dn && isFunctionLike(dn)) {
                const sf2 = dn.getSourceFile();
                const label = `${relTo(repoRoot, sf2.getFilePath())}:${idForFn(sf2, dn).split(":").slice(1).join(":")}`;
                callees.push(label);
              }
            }
          }
        }
      });

      out[`${id}`] = uniq(callees).slice(0, 5);
    }
  }

  return out;
}

/** Build a simple project-wide call graph: node -> set of callees. */
export function buildProjectEdges(project: Project, repoRoot: string): Record<string, Set<string>> {
  const edges: Record<string, Set<string>> = {};
  function add(a: string, b: string) {
    (edges[a] ||= new Set<string>()).add(b);
  }

  for (const sf of project.getSourceFiles()) {
    const fns: FunctionLikeDeclaration[] = [];
    sf.forEachDescendant((n) => { if (isFunctionLike(n)) fns.push(n); });

    for (const fn of fns) {
      const a = `${relTo(repoRoot, sf.getFilePath())}:${idForFn(sf, fn).split(":").slice(1).join(":")}`;
      fn.forEachDescendant((n) => {
        if (!Node.isCallExpression(n)) return;
        const expr = n.getExpression();
        if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
          const target = resolveCalleeToFunction(expr);
          if (target) {
            const sf2 = target.getSourceFile();
            const b = `${relTo(repoRoot, sf2.getFilePath())}:${idForFn(sf2, target).split(":").slice(1).join(":")}`;
            add(a, b);
          } else {
            const ds = (Node.isIdentifier(expr) ? expr.getDefinitions() : expr.getNameNode().getDefinitions());
            for (const d of ds || []) {
              const dn = d.getDeclarationNode();
              if (dn && isFunctionLike(dn)) {
                const sf2 = dn.getSourceFile();
                const b = `${relTo(repoRoot, sf2.getFilePath())}:${idForFn(sf2, dn).split(":").slice(1).join(":")}`;
                add(a, b);
              }
            }
          }
        }
      });
      // ensure node appears even if no callees
      edges[a] ||= new Set<string>();
    }
  }
  return edges;
}
