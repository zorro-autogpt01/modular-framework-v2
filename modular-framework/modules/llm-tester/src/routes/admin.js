import { Router } from "express";
import { Storage } from "../storage.js";

const router = Router();

router.post("/webhooks", (req, res) => {
  const { event, url, secret } = req.body || {};
  if (!event || !url) return res.status(400).json({ error: "event_and_url_required" });
  const hook = Storage.addWebhook({ event, url, secret });
  res.json({ ok: true, id: hook.id });
});

// Config (RAG + Chat Replay)
router.get("/config", (req, res) => {
  res.json(Storage.getConfig());
});

router.put("/config", (req, res) => {
  const { ragEnabled, chatReplayEnabled } = req.body || {};
  if (ragEnabled != null && typeof ragEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "ragEnabled must be boolean" });
  if (chatReplayEnabled != null && typeof chatReplayEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "chatReplayEnabled must be boolean" });

  const saved = Storage.saveConfig({ ragEnabled, chatReplayEnabled });
  res.json({ ok: true, config: saved });
});

export default router;
