import { Router } from "express";
import { Storage } from "../storage.js";

import { logInfo, logWarn } from "../logger.js";

const router = Router();

router.post("/webhooks", (req, res) => {
  const rid = req.id; logInfo('LT admin webhook create <-', { rid, ip: req.ip, body: { event, url: url ? url.toString() : null } });

  const { event, url, secret } = req.body || {};
  if (!event || !url) return res.status(400).json({ error: "event_and_url_required" });
  const hook = Storage.addWebhook({ event, url, secret });
  logInfo('LT admin webhook create ->', { rid, id: hook.id });

  res.json({ ok: true, id: hook.id });
});

// Config (RAG + Chat Replay)
router.get("/config", (req, res) => {
  const rid = req.id; logInfo('LT admin config get', { rid, ip: req.ip });
  res.json(Storage.getConfig());
});

router.put("/config", (req, res) => {
  const rid = req.id; const { ragEnabled, chatReplayEnabled } = req.body || {};
  logInfo('LT admin config put <-', { rid, ip: req.ip, ragEnabled, chatReplayEnabled });
  if (ragEnabled != null && typeof ragEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "ragEnabled must be boolean" });
  if (chatReplayEnabled != null && typeof chatReplayEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "chatReplayEnabled must be boolean" });
  const saved = Storage.saveConfig({ ragEnabled, chatReplayEnabled });
  logInfo('LT admin config put ->', { rid, saved });
  res.json({ ok: true, config: saved });
});

export default router;
