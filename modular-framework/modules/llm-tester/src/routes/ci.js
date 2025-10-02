import { Router } from "express";
import { putFile } from "../github.js";
import fetch from "node-fetch";

const router = Router();

/**
 * Executes a suite, aggregates results, and commits a JSON report via GitHub Hub.
 * Note: GitHub Hub does not expose "check runs"; this writes a report file CI can consume.
 */
router.post("/github/check", async (req, res) => {
  const { repo, branch = "main", suite, path = "reports/llm-testing/report.json" } = req.body || {};
  if (!suite) return res.status(400).json({ error: "suite_required" });

  const base = process.env.EDGE_BASE?.replace(/\/$/, "") || "";
  const execUrl = `${base}/api/llm-testing/suites/${encodeURIComponent(suite)}/execute`;
  const execResp = await fetch(execUrl, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ stopOnFail: false }) });
  const summary = await execResp.json();

  const content = JSON.stringify({ repo, branch, suite, timestamp: new Date().toISOString(), summary }, null, 2);
  const commit = await putFile({
    path,
    branch,
    content,
    message: `llm-testing: ${suite} -> ${summary.ok ? "PASS" : "FAIL"} (${summary.summary?.passed || 0}/${(summary.summary?.passed || 0)+(summary.summary?.failed || 0)})`
  });

  res.json({ ok: true, commit });
});

export default router;
