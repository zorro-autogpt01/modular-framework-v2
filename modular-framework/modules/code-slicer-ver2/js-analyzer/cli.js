#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { runAnalyze } from "./analyze.js";

function parseArgs(argv: string[]) {
  const out: any = { ignoreGlobs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined);
    if (a === "--repo") out.repo = next(), i++;
    else if (a === "--out") out.out = next(), i++;
    else if (a === "--profile") out.profile = true;
    else if (a === "--max-files") out.maxFiles = Number(next()), i++;
    else if (a === "--ignore-globs") {
      // Collect one or more globs until next flag
      const globs: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        globs.push(argv[++i]);
      }
      out.ignoreGlobs.push(...globs);
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
    console.log(`Usage: slicer-js --repo <path> --out <dir> [--profile] [--ignore-globs <g1> <g2> ...] [--max-files N]`);
    process.exit(args.help ? 0 : 2);
  }

  const repo = path.resolve(args.repo);
  const outDir = path.resolve(args.out);
  ensureDir(outDir);

  const ignoreGlobs: string[] = [
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.turbo/**",
    "**/.git/**",
    "**/.idea/**",
    "**/.vscode/**",
    ...args.ignoreGlobs
  ];

  const { profile, filesCount } = await runAnalyze({
    repo,
    out: outDir,
    ignoreGlobs,
    maxFiles: args.maxFiles,
    profileOnly: !!args.profile
  });

  // Always write profile.json (orchestrator expects it)
  fs.writeFileSync(path.join(outDir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");

  if (args.profile) {
    console.log(`✅ JS profile written to ${path.join(outDir, "profile.json")}`);
  } else {
    console.log(`✅ JS analysis done. Files: ${filesCount}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
