import fetch from "node-fetch";

function joinBase(base, path) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}${path}`;
}
function toAbsolute(baseUrl) {
  if (/^https?:\/\//i.test(baseUrl)) return baseUrl;
  const edge = process.env.EDGE_BASE;
  if (!edge) throw new Error("EDGE_BASE is required to call gateway via edge");
  const e = edge.endsWith("/") ? edge.slice(0, -1) : edge;
  return e + baseUrl;
}

export async function chatCompletion({ baseUrl, headers = {}, model, messages, stream = false }) {
  const url = joinBase(toAbsolute(baseUrl), "/v1/chat/completions");
  const mergedHeaders = { "Content-Type": "application/json", ...headers };
  if (process.env.GATEWAY_KEY && !mergedHeaders.Authorization) {
    mergedHeaders.Authorization = `Bearer ${process.env.GATEWAY_KEY}`;
  }
  const body = { model, messages, stream: false }; // we aggregate; SSE handled by our module
  const r = await fetch(url, { method: "POST", headers: mergedHeaders, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || r.statusText || "Gateway error";
    throw new Error(`Gateway ${r.status}: ${msg}`);
  }
  const content = j?.choices?.[0]?.message?.content ?? "";
  return { raw: j, content };
}
