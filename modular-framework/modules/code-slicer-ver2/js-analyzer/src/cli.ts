#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { runAnalyze } from "./analyze";

function parseArgs(argv: string[]) {
  const out: any = { ignoreGlobs: [], targets: [], hints: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined);
    if (a === "--repo") out.repo = next(), i++;
    else if (a === "--out") out.out = next(), i++;
    else if (a === "--profile") out.profile = true;
    else if (a === "--max-files") out.maxFiles = Number(next()), i++;
    else if (a === "--ignore-globs") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.ignoreGlobs.push(argv[++i]);
    } else if (a === "--target") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.targets.push(argv[++i]);
    } else if (a === "--targets-file") {
      const p = next(); i++;
      if (p && fs.existsSync(p)) {
        const txt = fs.readFileSync(p, "utf-8").split(/\r?\n/).map((l)=>l.trim()).filter(Boolean);
        out.targets.push(...txt);
      }
    } else if (a === "--api-type") {
      const v = next(); i++;
      out.apiType = (v === "function" ? "function" : "http");
    } else if (a === "--context") out.context = Number(next()), i++;
    else if (a === "--hint") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.hints.push(argv[++i]);
    } else if (a === "-v" || a === "--verbose") out.verbose = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo || !args.out) {
    console.log(`Usage: slicer-js --repo <path> --out <dir> [--profile]
  [--target <t1> <t2> ... | --targets-file file] [--api-type http|function]
  [--ignore-globs <g1> <g2> ...] [--hint <h1> <h2> ...] [--context N] [--max-files N]`);
    process.exit(args.help ? 0 : 2);
  }

  const repo = path.resolve(args.repo);
  const outDir = path.resolve(args.out);
  ensureDir(outDir);

  const ignoreGlobs: string[] = [
    "**/node_modules/**","**/.next/**","**/dist/**","**/build/**","**/out/**","**/.turbo/**",
    "**/.git/**","**/.idea/**","**/.vscode/**",
    ...args.ignoreGlobs
  ];

  const { profile } = await runAnalyze({
    repo,
    out: outDir,
    ignoreGlobs,
    maxFiles: args.maxFiles,
    profileOnly: !!args.profile,
    targets: args.targets,
    apiType: args.apiType || "http",
    context: args.context,
    hints: args.hints
  });

  // profile.json always written for merger compatibility
  fs.writeFileSync(path.join(outDir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");

  console.log(args.profile ? `✅ JS profile -> ${path.join(outDir, "profile.json")}` : `✅ JS slice written to ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
