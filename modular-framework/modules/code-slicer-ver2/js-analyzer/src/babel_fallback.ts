import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

export function tryBabelParse(code: string) {
  try {
    const ast = parse(code, {
      sourceType: "unambiguous",
      plugins: [
        "typescript","jsx","decorators-legacy","classProperties","classPrivateProperties","classPrivateMethods",
        "dynamicImport","importMeta","doExpressions","optionalChaining","nullishCoalescingOperator","topLevelAwait","logicalAssignment"
      ]
    });
    traverse(ast, {});
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}
