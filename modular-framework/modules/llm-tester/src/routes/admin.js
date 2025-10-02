import { Router } from "express";
import { Storage } from "../storage.js";

const router = Router();

router.post("/webhooks", (req, res) => {
  const { event, url, secret } = req.body || {};
  if (!event || !url) return res.status(400).json({ error: "event_and_url_required" });
  const hook = Storage.addWebhook({ event, url, secret });
  res.json({ ok: true, id: hook.id });
});

export default router;
