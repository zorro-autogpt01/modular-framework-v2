import { Router } from "express";
import { Storage } from "../storage.js";
import { openSSE, send, close } from "../sse.js";
import { toJUnitXml } from "../junit.js";
import fetch from "node-fetch";

const router = Router();

router.get("/", (req, res) => {
  res.json({ items: Storage.listSuites() });
});

router.post("/", (req, res) => {
  try {
    const suite = Storage.saveSuite(req.body || {});
    return res.json({ ok: true, suiteId: suite.name });
  } catch (e) {
    return res.status(400).json({ error: "invalid_suite", message: e.message });
  }
});

router.post("/:name/execute", async (req, res) => {
  const { name } = req.params;
  const suite = Storage.listSuites().find(s => s.name === name);
  if (!suite) return res.status(404).json({ error: "not_found", message: "suite not found" });

  const doStream = String(req.query.stream || "").toLowerCase() === "true" || req.headers.accept?.includes("text/event-stream");
  if (doStream) openSSE(res), send(res, { type: "suite", name });

  // Select tests
  let tests = Storage.listTests({ suite: name });
  if (!tests.length) {
    if (doStream) send(res, { type: "done", ok: true, runIds: [], summary: { passed: 0, failed: 0, durationMs: 0 } }), close(res);
    return res.json({ ok: true, suite: name, runIds: [], summary: { passed: 0, failed: 0, durationMs: 0 } });
  }

  const start = Date.now();
  const runIds = [];
  let passed = 0, failed = 0;

  // Sequential for simplicity (you can parallelize with Promise.allSettled respecting rate limits)
  for (const t of tests) {
    if (doStream) send(res, { type: "execute", testId: t.id });
    // Fire internal HTTP to our own test execute endpoint
    const base = process.env.EDGE_BASE?.replace(/\/$/, "") || "";
    const url = `${base}/api/llm-testing/tests/${t.id}/execute`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const j = await r.json();
    runIds.push(j.runId);
    if (j.ok) passed++; else failed++;
    if (doStream) send(res, { type: "result", testId: t.id, ok: j.ok, runId: j.runId });
    if (req.body?.stopOnFail && !j.ok) break;
  }

  const durationMs = Date.now() - start;
  const ok = failed === 0;
  const summary = { passed, failed, durationMs };

  // Optional JUnit result (compute from recent suite runs)
  if (!doStream) {
    return res.json({ ok, suite: name, runIds, summary });
  } else {
    send(res, { type: "done", ok, suite: name, runIds, summary });
    return close(res);
  }
});

export default router;
