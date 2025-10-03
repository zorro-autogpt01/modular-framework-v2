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
  logInfo("LT CI github/check <-", { rid, ip: req.ip, repo, branch, suite, path: reportPath });

  if (!suite) return res.status(400).json({ error: "suite_required" });

  const base = process.env.EDGE_BASE?.replace(/\/$/, "") || "";
  const execUrl = `${base}/api/llm-tester/suites/${encodeURIComponent(suite)}/execute`;
  const execResp = await fetch(execUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stopOnFail: false }),
  });
  const summary = await execResp.json();
  logInfo("LT CI suite executed", {
    rid,
    suite,
    ok: summary?.ok,
    passed: summary?.summary?.passed,
    failed: summary?.summary?.failed,
  });

  const content = JSON.stringify(
    { repo, branch, suite, timestamp: new Date().toISOString(), summary },
    null,
    2
  );

  const commit = await putFile({
    path: reportPath,
    branch,
    content,
    message: `llm-tester: ${suite} -> ${summary.ok ? "PASS" : "FAIL"} (${summary.summary?.passed || 0}/${
      (summary.summary?.passed || 0) + (summary.summary?.failed || 0)
    })`,
  });
  logInfo("LT CI github commit", {
    rid,
    path: reportPath,
    branch,
    suite,
    commit: commit?.commit?.sha || null,
  });

  logInfo("LT CI github/check ->", { rid, ok: true });
  res.json({ ok: true, commit });
});

export default router;
