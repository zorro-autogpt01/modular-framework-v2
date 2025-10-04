import { Router } from "express";
import { Storage } from "../storage.js";
import { openSSE, send, close } from "../sse.js";
import { toJUnitXml } from "../junit.js";
import fetch from "node-fetch"; // If you're on Node 18+, you can use global fetch and remove this line.
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
  const { name } = req.params;
  const suite = Storage.listSuites().find((s) => s.name === name);
  if (!suite) return res.status(404).json({ error: "not_found", message: "suite not found" });

  logInfo("Suite execution started", { suiteName: name }, "suites");

  const doStream =
    String(req.query.stream || "").toLowerCase() === "true" ||
    (req.headers.accept && req.headers.accept.includes("text/event-stream"));

  if (doStream) {
    openSSE(res);
    send(res, { type: "suite", name });
  }

  // Select tests
  let tests = Storage.listTests({ suite: name });

  if (!tests.length) {
    const empty = {
      ok: true,
      suite: name,
      runIds: [],
      summary: { passed: 0, failed: 0, durationMs: 0 },
    };
    if (doStream) {
      send(res, { type: "done", ...empty });
      return close(res);
    }
    return res.json(empty);
  }

  const base =
    (process.env.EDGE_BASE?.replace(/\/$/, "")) ||
    `http://localhost:${process.env.PORT || 3040}`;

  const start = Date.now();
  const runIds = [];
  let passed = 0,
    failed = 0;

  // Sequential execution
  for (const t of tests) {
    if (doStream) send(res, { type: "execute", testId: t.id });

    const url = `${base}/api/llm-tester/tests/${encodeURIComponent(t.id)}/execute`;

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      const j = JSON.parse(txt);

      runIds.push(j.runId);
      if (j.ok) passed++;
      else failed++;

      if (doStream) send(res, { type: "result", testId: t.id, ok: j.ok, runId: j.runId });
      if (req.body?.stopOnFail && !j.ok) break;
    } catch (e) {
      logError("Failed to execute test in suite", { testId: t.id, error: e.message }, "suites");
      failed++;
      if (doStream) send(res, { type: "result", testId: t.id, ok: false, error: e.message });
      if (req.body?.stopOnFail) break;
    }
  }

  const durationMs = Date.now() - start;
  const ok = failed === 0;
  const summary = { passed, failed, durationMs };

  logInfo(
    "Suite execution completed",
    { suiteName: name, ok, passed, failed, durationMs },
    "suites"
  );

  if (doStream) {
    send(res, { type: "done", ok, suite: name, runIds, summary });
    return close(res);
  }

  // Optional JUnit result
  if ((req.query.report || "").toString().toLowerCase() === "junit") {
    const runs = runIds.map((id) => Storage.getRun(id)).filter(Boolean);
    const xml = toJUnitXml({ suiteName: name, runs });
    res.setHeader("Content-Type", "application/xml");
    return res.send(xml);
  }

  return res.json({ ok, suite: name, runIds, summary });
});

export default router;
