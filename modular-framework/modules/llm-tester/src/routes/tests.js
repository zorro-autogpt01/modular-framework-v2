import { Router } from "express";
import { Storage } from "../storage.js";
import { chatCompletion } from "../llm.js";
import { getFile } from "../github.js";
import { retrieve } from "../rag.js";
import { openSSE, send, close } from "../sse.js";
import { buildMessages, assertAll } from "../util.js";
import { notifyWebhooks } from "../webhook.js";
import { randomUUID } from "node:crypto";
import { logWarn } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  const { suite, tag, limit } = req.query;
  const items = Storage.listTests({
    suite,
    tag,
    limit: limit ? parseInt(limit, 10) : undefined
  });
  res.json({ items });
});

router.post("/", (req, res) => {
  const t = req.body || {};
  if (!t.name || !t.suite || !t.kind) return res.status(400).json({ error: "name, suite, kind required" });
  const saved = Storage.saveTest(t);
  res.json({ ok: true, testId: saved.id, version: saved.version });
});

router.get("/:id", (req, res) => {
  const t = Storage.getTest(req.params.id);
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

router.put("/:id", (req, res) => {
  const existing = Storage.getTest(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });
  const saved = Storage.saveTest({ ...existing, ...req.body, id: existing.id });
  res.json({ ok: true, testId: saved.id, version: saved.version });
});

router.post("/:id/execute", async (req, res) => {
  const test = Storage.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "not_found" });

  const doStream = String(req.query.stream || "").toLowerCase() === "true" || req.headers.accept?.includes("text/event-stream");
  let startedAt = new Date().toISOString();

  if (doStream) openSSE(res), send(res, { type: "phase", phase: "prepare" });

  try {
    // Artifact (tolerant)
    let artifactContent = "";
    if (test.input?.artifact?.path) {
      try {
        if (doStream) send(res, { type: "artifact", path: test.input.artifact.path });
        artifactContent = await getFile(test.input.artifact);
      } catch (e) {
        logWarn("Artifact fetch failed, continuing without it", { path: test.input.artifact.path, error: e.message }, "artifact");
        if (test.input.artifact.fallback) {
          artifactContent = String(test.input.artifact.fallback);
          logWarn("Using fallback content for missing artifact", { path: test.input.artifact.path, len: artifactContent.length }, "artifact");
        } else if (test.input.artifact.optional) {
          artifactContent = "";
        } else {
          artifactContent = "Placeholder: CHANGELOG not available.";
          logWarn("Using placeholder for missing artifact", { path: test.input.artifact.path }, "artifact");
        }
      }
    }

    // RAG gate (global + per-test)
    const cfg = Storage.getConfig();
    const ragRequested = !!test.context?.ragQuery?.question;
    const ragDisabledPerTest = test.context?.disableRag === true;
    const canUseRag = cfg.ragEnabled && ragRequested && !ragDisabledPerTest;

    let ragContext = "";
    if (canUseRag) {
      if (doStream) send(res, { type: "rag", status: "retrieving" });
      try {
        ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 });
      } catch (e) {
        logWarn("RAG retrieve failed, continuing without RAG", { error: e.message }, "rag");
      }
    } else {
      if (doStream) send(res, { type: "rag", status: "skipped", reason: !cfg.ragEnabled ? "global_disabled" : (ragDisabledPerTest ? "test_disabled" : "not_requested") });
    }
    const ragUsed = Boolean(canUseRag && ragContext);

    const messages = buildMessages(test.input?.messages, {
      artifactContent,
      ragContext,
      staticContext: test.context?.static
    });

    if (doStream) send(res, { type: "llm", model: test.llmGateway?.model || "unknown" });

    const t0 = Date.now();
    const { content } = await chatCompletion({
      baseUrl: test.llmGateway?.baseUrl || "/llm-gateway/api",
      headers: test.llmGateway?.headers || {},
      model: test.llmGateway?.model,
      messages,
      stream: false
    });
    const latencyMs = Date.now() - t0;

    const { ok: baseOk, results } = assertAll({ completion: content, test });

    let judgeExplanations = [];
    if (test.assert?.semantic?.criteria?.length) {
      const j = test.assert.semantic;
      const judgePrompt = [
        { role: "system", content: `You are a strict evaluator. Rubric:\n${j.rubric || ""}\nReturn JSON exactly: {"scores":[{"criterion":"","score":0..1,"why":""},...]}` },
        { role: "user", content: `Candidate output:\n${content}\n\nNow evaluate.` }
      ];
      const { content: judgeOut } = await chatCompletion({
        baseUrl: j.judge.baseUrl || test.llmGateway?.baseUrl || "/llm-gateway/api",
        headers: j.judge.headers || test.llmGateway?.headers || {},
        model: j.judge.model || test.llmGateway?.model,
        messages: judgePrompt
      });
      let parsed = {};
      try { parsed = JSON.parse(judgeOut); } catch { parsed = {}; }
      const scores = parsed?.scores || [];
      for (const c of (j.criteria || [])) {
        const got = scores.find(s => (s.criterion || "").toLowerCase().includes(c.name.toLowerCase()));
        const score = got?.score ?? 0;
        const pass = score >= c.minScore;
        results.push({ name: `semantic:${c.name}`, ok: pass, score, why: got?.why });
        if (got?.why) judgeExplanations.push({ criterion: c.name, why: got.why });
      }
    }

    const ok = results.every(r => r.ok);
    const run = {
      runId: "run_" + randomUUID(),
      testId: test.id,
      suite: test.suite,
      ok,
      startedAt,
      endedAt: new Date().toISOString(),
      latencyMs,
      assertions: results,
      artifacts: {
        prompt: messages,
        completion: content,
        judgeExplanations,
        ragUsed,
        llmGateway: test.llmGateway || null
      }
    };

    Storage.saveRun(run);
    await notifyWebhooks(Storage.listWebhooks(), ok ? "run.finished" : "run.failed", run);

    if (doStream) {
      send(res, { type: "assertions", results });
      send(res, { type: "done", ok, latencyMs, runId: run.runId });
      return close(res);
    } else {
      return res.json(run);
    }
  } catch (e) {
    if (doStream) {
      send(res, { type: "error", message: e.message || String(e) });
      return close(res);
    }
    return res.status(500).json({ error: "execute_failed", message: e.message || String(e) });
  }
});

router.get("/:id/replay", async (req, res) => {
  const test = Storage.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "not_found" });

  // Artifact
  let artifactContent = "";
  if (test.input?.artifact?.path) {
    try {
      artifactContent = await getFile(test.input.artifact);
    } catch {
      artifactContent = test.input?.artifact?.fallback || (test.input?.artifact?.optional ? "" : "Placeholder: artifact unavailable.");
    }
  }

  // RAG
  const cfg = Storage.getConfig();
  const ragRequested = !!test.context?.ragQuery?.question;
  const ragDisabledPerTest = test.context?.disableRag === true;

  const mode = (req.query.includeRag || "auto").toString();
  const allowAuto = cfg.ragEnabled && ragRequested && !ragDisabledPerTest;
  const includeRag =
    mode === "true" ? true :
    mode === "false" ? false :
    allowAuto;

  let ragContext = "";
  if (includeRag) {
    try { ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 }); } catch {}
  }

  const messages = buildMessages(test.input?.messages, {
    artifactContent,
    ragContext,
    staticContext: test.context?.static
  });

  const payload = {
    provider: "openai-compatible",
    baseUrl: "/llm-gateway/api",
    model: test.llmGateway?.model || "gpt-4o-mini",
    messages
  };

  res.json({
    ok: true,
    replay: payload,
    info: {
      ragIncluded: includeRag && !!ragContext,
      ragGloballyEnabled: cfg.ragEnabled === true,
      ragRequested,
      ragDisabledPerTest
    }
  });
});

export default router;