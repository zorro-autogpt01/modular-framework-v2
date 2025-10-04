import { Router } from "express";
import { Storage } from "../storage.js";
import { openSSE, send, close } from "../sse.js";
import { toJUnitXml } from "../junit.js";
import fetch from "node-fetch";
import { logInfo, logError } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  res.json({ items: Storage.listSuites() });
});

router.post("/", (req, res) => {
  try {
    const suite = Storage.saveSuite(req.body || {});
    logInfo("Suite created", { suiteName: suite.name }, "suites");
    return res.json({ ok: true, suiteId: suite.name });
  } catch (e) {
    logError("Failed to create suite", { error: e.message }, "suites");
    return res.status(400).json({ error: "invalid_suite", message: e.message });
  }
});

router.post("/:name/execute", async (req, res) => {
  const rid = req.id;
  const { name } = req.params;
  const suite = Storage.listSuites().find(s => s.name === name);
  if (!suite) return res.status(404).json({ error: "not_found", message: "suite not found" });

  logInfo("Suite execution started", { rid, suiteName: name }, "suites");
  
  const doStream = String(req.query.stream || "").toLowerCase() === "true" || req.headers.accept?.includes("text/event-stream");
  if (doStream) openSSE(res), send(res, { type: "suite", name });

  // Select tests
  let tests = Storage.listTests({ suite: name });
  if (!tests.length) {
    const empty = { ok: true, suite: name, runIds: [], summary: { passed: 0, failed: 0, durationMs: 0 } };
    if (doStream) { send(res, { type: "done", ...empty }); close(res); }
    return res.json(empty);
  }

  const start = Date.now();
  const runIds = [];
  let passed = 0, failed = 0;

  // Sequential for simplicity (can parallelize with Promise.allSettled + rate limits)
  for (const t of tests) {
    const base = (process.env.EDGE_BASE?.replace(/\/$/, "")) || `http://localhost:${process.env.PORT || 3040}`;
    const url = `${base}/api/llm-tester/tests/${encodeURIComponent(t.id)}/execute`;

    if (doStream) send(res, { type: "execute", testId: t.id, url });
    logInfo("Suite executing test", { rid, suite: name, testId: t.id, url }, "suites");

    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const txt = await r.text();
      const latencyMs = Date.now() - t0;

      if (!r.ok) {
        logError("Suite test HTTP error", { rid, testId: t.id, status: r.status, latencyMs, bodyPreview: txt.slice(0, 500) }, "suites");
        failed++;
        if (doStream) send(res, { type: "result", testId: t.id, ok: false, http: r.status, error: txt.slice(0, 200) });
        if (req.body?.stopOnFail) break;
        continue;
      }

      let j;
      try { j = JSON.parse(txt); }
      catch (e) {
        logError("Suite test invalid JSON", { rid, testId: t.id, latencyMs, parseError: e.message, preview: txt.slice(0, 200) }, "suites");
        failed++;
        if (doStream) send(res, { type: "result", testId: t.id, ok: false, error: "invalid_json" });
        if (req.body?.stopOnFail) break;
        continue;
      }

      runIds.push(j.runId);
      if (j.ok) passed++; else failed++;
      if (doStream) send(res, { type: "result", testId: t.id, ok: j.ok, runId: j.runId, latencyMs });
      logInfo("Suite test done", { rid, testId: t.id, ok: j.ok, runId: j.runId, latencyMs }, "suites");

      if (req.body?.stopOnFail && !j.ok) break;
    } catch (e) {
      const latencyMs = Date.now() - t0;
      logError("Suite test fetch error", { rid, testId: t.id, error: e.message, stack: e.stack, latencyMs, url }, "suites");
      failed++;
      if (doStream) send(res, { type: "result", testId: t.id, ok: false, error: e.message });
      if (req.body?.stopOnFail) break;
    }
  }

  const durationMs = Date.now() - start;
  const ok = failed === 0;
  const summary = { passed, failed, durationMs };

  logInfo("Suite execution completed", { rid, suiteName: name, ok, passed, failed, durationMs }, "suites");

  // Optional JUnit result (compute from recent suite runs)
  if (!doStream) {
    return res.json({ ok, suite: name, runIds, summary });
  } else {
    send(res, { type: "done", ok, suite: name, runIds, summary });
    return close(res);
  }
});

export default router;
