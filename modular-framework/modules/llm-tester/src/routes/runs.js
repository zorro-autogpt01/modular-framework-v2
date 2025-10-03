import { Router } from "express";
import { Storage } from "../storage.js";

import { logInfo } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  const rid = req.id; const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  logInfo('LT runs list', { rid, ip: req.ip, limit });
  res.json({ items: Storage.listRuns(limit) });
});

router.get("/:runId", (req, res) => {
  const rid = req.id; const run = Storage.getRun(req.params.runId);
  logInfo('LT runs get', { rid, runId: req.params.runId, found: !!run });
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json(run);
});

router.post("/:runId/retry", (req, res) => {
  const rid = req.id; const prev = Storage.getRun(req.params.runId);
  logInfo('LT runs retry', { rid, runId: req.params.runId, exists: !!prev });
  if (!prev) return res.status(404).json({ error: "not_found" });
  res.status(400).json({ error: "use_tests_execute", message: `re-run using /tests/${prev.testId}/execute` });
});

export default router;
