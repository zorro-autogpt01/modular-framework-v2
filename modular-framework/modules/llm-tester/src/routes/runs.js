import { Router } from "express";
import { Storage } from "../storage.js";

const router = Router();

router.get("/", (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  res.json({ items: Storage.listRuns(limit) });
});

router.get("/:runId", (req, res) => {
  const run = Storage.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json(run);
});

router.post("/:runId/retry", (req, res) => {
  const prev = Storage.getRun(req.params.runId);
  if (!prev) return res.status(404).json({ error: "not_found" });
  // For simplicity, instruct clients to POST /tests/:id/execute again with same testId.
  res.status(400).json({ error: "use_tests_execute", message: `re-run using /tests/${prev.testId}/execute` });
});

export default router;
