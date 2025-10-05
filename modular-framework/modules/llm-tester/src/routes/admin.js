import { Router } from "express";
import { Storage } from "../storage.js";

import { logInfo } from "../logger.js";

const router = Router();

router.post("/webhooks", (req, res) => {
  const rid = req.id;
  const { event, url, secret } = req.body || {};
  logInfo('LT admin webhook create <-', { rid, ip: req.ip, body: { event, url } }, 'admin');

  if (!event || !url) return res.status(400).json({ error: "event_and_url_required" });
  const allowed = ['run.finished', 'run.failed'];
  if (!allowed.includes(event)) return res.status(400).json({ error: "invalid_event", allowed });

  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https supported');
  } catch (e) {
    return res.status(400).json({ error: "invalid_url", message: e.message });
  }

  const hook = Storage.addWebhook({ event, url: String(url), secret });
  logInfo('LT admin webhook create ->', { rid, id: hook.id }, 'admin');

  res.json({ ok: true, id: hook.id });
});

// Config (RAG + Chat Replay)
router.get("/config", (req, res) => {
  const rid = req.id; logInfo('LT admin config get', { rid, ip: req.ip }, 'admin');
  res.json(Storage.getConfig());
});

router.put("/config", (req, res) => {
  const rid = req.id; const { ragEnabled, chatReplayEnabled } = req.body || {};
  logInfo('LT admin config put <-', { rid, ip: req.ip, ragEnabled, chatReplayEnabled }, 'admin');
  if (ragEnabled != null && typeof ragEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "ragEnabled must be boolean" });
  if (chatReplayEnabled != null && typeof chatReplayEnabled !== "boolean")
    return res.status(400).json({ error: "invalid_value", message: "chatReplayEnabled must be boolean" });
  const saved = Storage.saveConfig({ ragEnabled, chatReplayEnabled });
  logInfo('LT admin config put ->', { rid, saved }, 'admin');
  res.json({ ok: true, config: saved });
});

// Templates CRUD
router.get("/templates", (req, res) => {
  const rid = req.id; logInfo('LT admin templates list', { rid, ip: req.ip }, 'admin');
  res.json({ items: Storage.listTemplates() });
});

router.post("/templates", (req, res) => {
  const rid = req.id; const body = req.body || {};
  logInfo('LT admin template create <-', { rid, name: body?.name, kind: body?.kind }, 'admin');
  if (!body.name || !body.kind) return res.status(400).json({ error: "name_and_kind_required" });
  try {
    const saved = Storage.saveTemplate({ name: body.name, kind: body.kind, description: body.description || "", defaults: body.defaults || {} });
    logInfo('LT admin template create ->', { rid, id: saved.id }, 'admin');
    res.json({ ok: true, id: saved.id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'invalid_template' });
  }
});

router.get("/templates/:id", (req, res) => {
  const rid = req.id; const tpl = Storage.getTemplate(req.params.id);
  logInfo('LT admin template get', { rid, id: req.params.id, found: !!tpl }, 'admin');
  if (!tpl) return res.status(404).json({ error: "not_found" });
  res.json(tpl);
});

router.put("/templates/:id", (req, res) => {
  const rid = req.id; const existing = Storage.getTemplate(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const merged = { ...existing, ...req.body, id: existing.id };
  try {
    const saved = Storage.saveTemplate(merged);
    logInfo('LT admin template put', { rid, id: saved.id }, 'admin');
    res.json({ ok: true, id: saved.id });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'invalid_template' });
  }
});

router.delete("/templates/:id", (req, res) => {
  const rid = req.id;
  const r = Storage.deleteTemplate(req.params.id);
  logInfo('LT admin template delete', { rid, id: req.params.id, deleted: r.deleted }, 'admin');
  res.json({ ok: true, ...r });
});
export default router;
