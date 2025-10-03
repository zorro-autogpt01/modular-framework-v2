import fetch from "node-fetch";

import { logInfo, logWarn } from './logger.js';

function edge(path) {
  const base = process.env.EDGE_BASE;
  if (!base) throw new Error("EDGE_BASE is required");
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + "/api/github-hub/api" + path;
}

export async function getFile({ path: filePath, branch = "main" }) {
  logInfo('LT github getFile', { path: filePath, branch });

  const url = new URL(edge("/file"));
  url.searchParams.set("path", filePath);
  url.searchParams.set("branch", branch);
  const r = await fetch(url.toString());
  const j = await r.json();
  if (!r.ok) logWarn('LT github putFile error', { status: r.status, message: j?.message });
  else logInfo('LT github putFile ok', { sha: j?.commit?.sha || null });

  if (!r.ok) logWarn('LT github getFile error', { status: r.status, message: j?.message });
  else logInfo('LT github getFile ok', { size: (j?.decoded_content||'').length });

  if (!r.ok) throw new Error(`GitHub Hub file error: ${r.status} ${j?.message || ""}`);
  return j.decoded_content || "";
}

export async function putFile({ path: filePath, content, message, branch = "main", sha }) {
  logInfo('LT github putFile', { path: filePath, branch, size: (content||'').length });

  const r = await fetch(edge("/file"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, message, content, branch, sha })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`GitHub Hub put file error: ${r.status} ${j?.message || ""}`);
  return j;
}
