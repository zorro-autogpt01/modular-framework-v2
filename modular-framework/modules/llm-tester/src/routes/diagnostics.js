import { Router } from 'express';
import { chatCompletion } from '../llm.js';
import { retrieve } from '../rag.js';
import { logInfo, logError } from '../logger.js';

const router = Router();

// GIT: /api/llm-tester/diagnostics/gateway
// Quick ping bypasses the Gateway api (PAST/v1/chat) with a mini-message and reports latency/content.
router.get('/gateway', async (req, res) => { const rid = req.id;
  const baseUrl = (req.query.baseUrl || "/llm-gateway/api").toString();
  const model = (req.query.model || "gpt-4o-mini").toString();
  const messages = [
    { role: "system", content: "Connectivity check. Reply with 'pong'." },
    { role: "user", content: "ping" }
  ];

  const t0 = Date.now();
  try {
    const { content } = await chatCompletion({ baseUrl, model, messages, headers: { } });
    const latencyMs = Date.now() - t0;
    logInfo('LT diag gateway', { rid, baseUrl, model, latencyMs, messages, response: content }, 'diag');
    return res.json({ ok: true, baseUrl, model, latencyMs, content, contentLength: content?.length || 0 });
  } catch (e) {
    logError('LT diag gateway failed', { rid, baseUrl, model, error: e.message, stack: e.stack }, 'diag');
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

// GIT: /api/llm-tester/diagnostics/rag
// Run a basic RAG retrieve probe, with default question, and report snippets + combined text.
router.get('/rag', async (req, res) => { const rid = req.id; const question = (req.query.question || "ping connectivity check").toString();
  const t0 = Date.now();
  try {
    const context = await retrieve({ question: question, top_k: 1 });
    const latencyMs = Date.now() - t0;
    logInfo('LT diag rag', { rid, question, latencyMs, content: context }, 'diag');
    return res.json({ ok: true, question, latencyMs, content: context, contentLength: context.length });
  } catch (e) {
    logError( 'LT diag rag failed', { rid, error: e.message, stack: e.stack }, 'diag');
    return res.status(500).json({ ok: false, error: e.message || 'failed' });
  }
});

// GIT: /api/llm-tester/diagnostics/connectivity
// Performs both probes and returns a summary of results.
router.get('/connectivity', async (req, res) => { const rid = req.id; const model = (req.query.model || "gpt-4o-mini").toString(); const baseUrl = (req.query.baseUrl || "/llm-gateway/api").toString(); const question = (req.query.question || "ping connectivity check").toString();
  const results = { gateway: null, rag: null };
  // Gateway
  try {
    const messages = [{ role: "system", content: "Connectivity check. Reply with 'pong'." }, { role: "user", content: "ping" }];
    const t = Date.now();
    const { content } = await chatCompletion({ baseUrl, model, messages, headers: {} });
    results.gateway = { ok: true, latencyMs: Date.now() - t, contentLength: content?.length || 0 };
  } catch (e) {
    results.gateway = { ok: false, error: e.message };
  }
  // RAG
  try {
    const tr = Date.now();
    const context = await retrieve({ question: question, top_k: 1 });
    results.rag = { ok: true, latencyMs: Date.now() - tr, snippetCount: (context.split("\n---\n") || []).length, totalLength: context.length };
  } catch (e) {
    results.rag = { ok: false, error: e.message };
  }
  return res.json({ ok: (results.gateway?.ok && results.rag?.ok) || false, results });
});

export default router;
