import { Router } from "express";
import { putFile } from "../github.js";
import fetch from "node-fetch";

import { logInfo, logError } from "../logger.js";

const router = Router();

/**
 * Executes a suite, aggregates results, and commits a JSON report via GitHub Hub.
 * Note: GitHub Hub does not expose "check runs"; this writes a report file CI can consume.
 */
router.post("/github/check", async (req, res) => {
  const rid = req.id;
  const { repo, branch = "main", suite, path: reportPath = "reports/llm-tester/report.json" } = req.body || {};
  logInfo("LT CI github/check <-", { rid, ip: req.ip, repo, branch, suite, path: reportPath }, "ci");

  if (!suite) return res.status(400).json({ error: "suite_required" });

  const base = (process.env.EDGE_BASE?.replace(/\/$/, "")) || `http://localhost:${process.env.PORT || 3040}`;
  const execUrl = `${base}/api/v1/tester/suites/${encodeURIComponent(suite)}/execute`;
  let exec;
  const t0 = Date.now();
  try {
    const execResp = await fetch(execUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopOnFail: false }),
    });
    const text = await execResp.text();
    const latencyMs = Date.now() - t0;
    if (!execResp.ok) {
      logError("LT CI suite execute failed", { rid, status: execResp.status, latencyMs, body: text.slice(0, 500), url: execUrl }, "ci");
      return res.status(502).json({ ok: false, error: `suite_execute_${execResp.status}` });
    }
    try { exec = JSON.parse(text); } catch (e) {
      logError("LT CI suite execute invalid JSON", { rid, error: e.message, preview: text.slice(0, 200), url: execUrl }, "ci");
      return res.status(502).json({ ok: false, error: "suite_execute_invalid_json" });
    }
  } catch (e) {
    logError("LT CI fetch error", { rid, error: e.message, stack: e.stack, url: execUrl }, "ci");
    return res.status(502).json({ ok: false, error: e.message });
  }

  logInfo("LT CI suite executed", {
    rid,
    suite,
    ok: exec?.ok,
    passed: exec?.summary?.passed,
    failed: exec?.summary?.failed,
  }, "ci");

  const content = JSON.stringify(
    { repo, branch, suite, timestamp: new Date().toISOString(), result: exec },
    null,
    2
  );

  let commit;
  try {
    commit = await putFile({
      path: reportPath,
      branch,
      content,
      message: `llm-tester: ${suite} -> ${exec.ok ? "PASS" : "FAIL"} (${exec.summary?.passed || 0}/${
        (exec.summary?.passed || 0) + (exec.summary?.failed || 0)
      })`,
    });
  } catch (e) {
    logError("LT CI github commit failed", { rid, error: e.message, stack: e.stack }, "ci");
    return res.status(502).json({ ok: false, error: e.message });
  }

  logInfo("LT CI github commit", {
    rid,
    path: reportPath,
    branch,
    suite,
    commit: commit?.commit?.sha || null,
  }, "ci");

  logInfo("LT CI github/check ->", { rid, ok: true }, "ci");
  res.json({ ok: true, commit });
});

export default router;
