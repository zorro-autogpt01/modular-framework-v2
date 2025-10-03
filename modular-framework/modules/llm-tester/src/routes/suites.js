import { Router } from "express";
import { Storage } from "../storage.js";
import { openSSE, send, close } from "../sse.js";
import { toJUnitXml } from "../junit.js"; // (optional; unused here but kept if you use it elsewhere)
import fetch from "node-fetch";

import { logInfo, logDebug, logWarn } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  const rid = req.id;
  logInfo("LT suites list", { rid, ip: req.ip });
  res.json({ items: Storage.listSuites() });
});

router.post("/", (req, res) => {
  const rid = req.id;
  try {
    const suite = Storage.saveSuite(req.body || {});
    logInfo("LT suites save", { rid, name: suite?.name });
    return res.json({ ok: true, suiteId: suite.name });
  } catch (e) {
    logWarn("LT suites save error", { rid, message: e.message });
    return res.status(400).json({ error: "invalid_suite", message: e.message });
  }
});

router.post("/:name/execute", async (req, res) => {
  const { name } = req.params;
  const rid = req.id;
  logInfo("LT suite execute <-", { rid, name, stream: String(req.query.stream || "") });

  const suite = Storage.listSuites().find((s) => s.name === name);
  if (!suite) return res.status(404).json({ error: "not_found", message: "suite not found" });
  logDebug("LT suite found", { rid, name });

  const doStream =
    String(req.query.stream || "").toLowerCase() === "true" ||
    req.headers.accept?.includes("text/event-stream");
  if (doStream) {
    openSSE(res);
    send(res, { type: "suite", name });
    logDebug("LT suite SSE open", { rid, name });
  }

  // Select tests
  const tests = Storage.listTests({ suite: name });
  if (!tests.length) {
    const summary = { passed: 0, failed: 0, durationMs: 0 };
    if (doStream) {
      send(res, { type: "done", ok: true, runIds: [], summary });
      return close(res);
    }
    return res.json({ ok: true, suite: name, runIds: [], summary });
  }

  const start = Date.now();
  const runIds = [];
  let passed = 0,
    failed = 0;
  logInfo("LT suite selected tests", { rid, count: tests.length });

  // Execute sequentially (simple & predictable)
  for (const t of tests) {
    if (doStream) send(res, { type: "execute", testId: t.id });

    const base = process.env.EDGE_BASE?.replace(/\/$/, "") || "";
    const url = `${base}/api/llm-tester/tests/${t.id}/execute`;
    logDebug("LT suite -> execute test", { rid, testId: t.id, url });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    logDebug("LT suite <- execute result", {
      rid,
      testId: t.id,
      ok: j?.ok,
      runId: j?.runId,
    });

    runIds.push(j.runId);
    if (j.ok) passed++;
    else failed++;

    if (doStream) send(res, { type: "result", testId: t.id, ok: j.ok, runId: j.runId });

    if (req.body?.stopOnFail && !j.ok) break;
  }

  const durationMs = Date.now() - start;
  const ok = failed === 0;
  const summary = { passed, failed, durationMs };
  logInfo("LT suite execute -> summary", { rid, ok, name, passed, failed, durationMs });

  if (!doStream) {
    return res.json({ ok, suite: name, runIds, summary });
  } else {
    send(res, { type: "done", ok, suite: name, runIds, summary });
    return close(res);
  }
});

export default router;
