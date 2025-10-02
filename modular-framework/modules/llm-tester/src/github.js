import fetch from "node-fetch";

function edge(path) {
  const base = process.env.EDGE_BASE;
  if (!base) throw new Error("EDGE_BASE is required");
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + "/api/github-hub/api" + path;
}

export async function getFile({ path: filePath, branch = "main" }) {
  const url = new URL(edge("/file"));
  url.searchParams.set("path", filePath);
  url.searchParams.set("branch", branch);
  const r = await fetch(url.toString());
  const j = await r.json();
  if (!r.ok) throw new Error(`GitHub Hub file error: ${r.status} ${j?.message || ""}`);
  return j.decoded_content || "";
}

export async function putFile({ path: filePath, content, message, branch = "main", sha }) {
  const r = await fetch(edge("/file"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, message, content, branch, sha })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`GitHub Hub put file error: ${r.status} ${j?.message || ""}`);
  return j;
}
