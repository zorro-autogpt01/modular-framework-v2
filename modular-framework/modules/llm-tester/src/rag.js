import fetch from "node-fetch";

import { logInfo, logWarn } from './logger.js';

function rag(path) {
  const base = process.env.EDGE_BASE;
  if (!base) throw new Error("EDGE_BASE is required");
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + "/rag" + path;
}

export async function retrieve({ question, top_k = 4 }) {
  logInfo('LT RAG retrieve ->', { top_k, hasQuestion: !!question });

  const r = await fetch(rag("/retrieve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question, top_k, dedupe_by: "file" })
  });
  const j = await r.json();
  if (!r.ok) logWarn('LT RAG retrieve error', { status: r.status, message: j?.message });
  else logInfo('LT RAG retrieve <-', { snippets: (j?.snippets||[]).length });

  if (!r.ok) throw new Error(`RAG retrieve error: ${r.status} ${j?.message || ""}`);
  const snippets = (j.snippets || []).map(s => s.text).filter(Boolean);
  return snippets.join("\n---\n");
}
