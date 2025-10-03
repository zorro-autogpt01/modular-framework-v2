import { Router } from "express";
import { Storage } from "../storage.js";
import { chatCompletion } from "../llm.js";
import { getFile } from "../github.js";
import { retrieve } from "../rag.js";
import { openSSE, send, close } from "../sse.js";
import { buildMessages, assertAll } from "../util.js";
import { notifyWebhooks } from "../webhook.js";
import { randomUUID } from "node:crypto";

import { logInfo, logWarn, logError, logDebug } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  const rid = req.id;
  const { suite, tag, limit } = req.query;
  logInfo("LT tests list", { rid, ip: req.ip, suite, tag, limit });
  const items = Storage.listTests({
    suite,
    tag,
    limit: limit ? parseInt(limit, 10) : undefined,
  });
  res.json({ items });
});

router.post("/", (req, res) => {
  const rid = req.id;
  const t = req.body || {};
  logInfo("LT tests create <-", { rid, name: t?.name, suite: t?.suite, kind: t?.kind });
  if (!t.name || !t.suite || !t.kind)
    return res.status(400).json({ error: "name, suite, kind required" });
  const saved = Storage.saveTest(t);
  logInfo("LT tests create ->", { rid, testId: saved.id });
  res.json({ ok: true, testId: saved.id, version: saved.version });
});

router.get("/:id", (req, res) => {
  const rid = req.id;
  const t = Storage.getTest(req.params.id);
  logInfo("LT tests get", { rid, id: req.params.id, found: !!t });
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

router.put("/:id", (req, res) => {
  const rid = req.id;
  const existing = Storage.getTest(req.params.id);
  if (!existing) {
    logWarn("LT tests update not_found", { rid, id: req.params.id });
    return res.status(404).json({ error: "not_found" });
  }
  const saved = Storage.saveTest({ ...existing, ...req.body, id: existing.id });
  logInfo("LT tests update ->", { rid, id: saved.id, version: saved.version });
  res.json({ ok: true, testId: saved.id, version: saved.version });
});

router.post("/:id/execute", async (req, res) => {
  const rid = req.id;
  logInfo("LT test execute <-", { rid, id: req.params.id, stream: String(req.query.stream || "") });

  const test = Storage.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "not_found" });
  logDebug("LT test found", { rid, id: test.id, suite: test.suite, kind: test.kind });

  const doStream =
    String(req.query.stream || "").toLowerCase() === "true" ||
    req.headers.accept?.includes("text/event-stream");
  const startedAt = new Date().toISOString();

  if (doStream) {
    openSSE(res);
    send(res, { type: "phase", phase: "prepare" });
    logDebug("LT test SSE open", { rid, id: test.id });
  }

  try {
    // Artifact
    let artifactContent = "";
    if (test.input?.artifact?.path) {
      logInfo("LT test artifact fetch", {
        rid,
        path: test.input.artifact.path,
        branch: test.input.artifact.branch || "main",
      });
      if (doStream) send(res, { type: "artifact", path: test.input.artifact.path });
      artifactContent = await getFile(test.input.artifact);
    }

    // RAG (global + per-test)
    const cfg = Storage.getConfig();
    const ragRequested = !!test.context?.ragQuery?.question;
    const ragDisabledPerTest = test.context?.disableRag === true;
    const canUseRag = cfg.ragEnabled && ragRequested && !ragDisabledPerTest;

    let ragContext = "";
    if (canUseRag) {
      logInfo("LT test RAG retrieve", { rid, question: test.context.ragQuery.question });
      if (doStream) send(res, { type: "rag", status: "retrieving" });
      ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 });
    } else if (doStream) {
      send(res, {
        type: "rag",
        status: "skipped",
        reason: !cfg.ragEnabled ? "global_disabled" : ragDisabledPerTest ? "test_disabled" : "not_requested",
      });
    }
    const ragUsed = Boolean(canUseRag && ragContext);

    const messages = buildMessages(test.input?.messages, {
      artifactContent,
      ragContext,
      staticContext: test.context?.static,
    });

    if (doStream) send(res, { type: "llm", model: test.llmGateway?.model || "unknown" });

    const t0 = Date.now();
    logInfo("LT test LLM call -> gateway", {
      rid,
      baseUrl: test.llmGateway?.baseUrl || "/llm-gateway/api",
      model: test.llmGateway?.model,
      messagesCount: messages.length,
    });

    const { content } = await chatCompletion({
      baseUrl: test.llmGateway?.baseUrl || "/llm-gateway/api",
      headers: test.llmGateway?.headers || {},
      model: test.llmGateway?.model,
      messages,
      stream: false,
    });
    const latencyMs = Date.now() - t0;
    logInfo("LT test LLM call <-", { rid, latencyMs, contentLen: (content || "").length });

    const { ok: baseOk, results } = assertAll({ completion: content, test });

    // Optional semantic judging
    let judgeExplanations = [];
    if (test.assert?.semantic?.criteria?.length) {
      const j = test.assert.semantic;
      const judgePrompt = [
        {
          role: "system",
          content: `You are a strict evaluator. Rubric:\n${j.rubric || ""}\nReturn JSON exactly: {"scores":[{"criterion":"","score":0..1,"why":""},...]}`,
        },
        { role: "user", content: `Candidate output:\n${content}\n\nNow evaluate.` },
      ];
      const { content: judgeOut } = await chatCompletion({
        baseUrl: j.judge.baseUrl || test.llmGateway?.baseUrl || "/llm-gateway/api",
        headers: j.judge.headers || test.llmGateway?.headers || {},
        model: j.judge.model || test.llmGateway?.model,
        messages: judgePrompt,
      });

      let parsed = {};
      try {
        parsed = JSON.parse(judgeOut);
      } catch {
        parsed = {};
      }
      const scores = parsed?.scores || [];
      for (const c of j.criteria || []) {
        const got = scores.find((s) => (s.criterion || "").toLowerCase().includes(c.name.toLowerCase()));
        const score = got?.score ?? 0;
        const pass = score >= c.minScore;
        results.push({ name: `semantic:${c.name}`, ok: pass, score, why: got?.why });
        if (got?.why) judgeExplanations.push({ criterion: c.name, why: got.why });
      }
    }

    const ok = results.every((r) => r.ok);
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
        llmGateway: test.llmGateway || null, // snapshot for replay helpers
      },
    };

    Storage.saveRun(run);
    logInfo("LT test run saved", { rid, runId: run.runId, ok });

    await notifyWebhooks(Storage.listWebhooks(), ok ? "run.finished" : "run.failed", run);
    logInfo("LT test webhooks notified", { rid, count: Storage.listWebhooks().length });

    if (doStream) {
      send(res, { type: "assertions", results });
      send(res, { type: "done", ok, latencyMs, runId: run.runId });
      return close(res);
    }
    return res.json(run);
  } catch (e) {
    logError("LT test execute error", { rid, id: req.params.id, message: e?.message || String(e) });
    if (doStream) {
      send(res, { type: "error", message: e.message || String(e) });
      return close(res);
    }
    return res.status(500).json({ error: "execute_failed", message: e.message || String(e) });
  }
});

router.get("/:id/replay", async (req, res) => {
  const rid = req.id;
  logInfo("LT test replay <-", { rid, id: req.params.id, includeRag: String(req.query.includeRag || "auto") });

  const test = Storage.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "not_found" });

  // Artifact
  let artifactContent = "";
  if (test.input?.artifact?.path) {
    artifactContent = await getFile(test.input.artifact);
  }

  // RAG
  const cfg = Storage.getConfig();
  const ragRequested = !!test.context?.ragQuery?.question;
  const ragDisabledPerTest = test.context?.disableRag === true;

  const mode = (req.query.includeRag || "auto").toString();
  const allowAuto = cfg.ragEnabled && ragRequested && !ragDisabledPerTest;
  const includeRag = mode === "true" ? true : mode === "false" ? false : allowAuto;

  let ragContext = "";
  if (includeRag) {
    ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 });
  }

  const messages = buildMessages(test.input?.messages, {
    artifactContent,
    ragContext,
    staticContext: test.context?.static,
  });

  const payload = {
    provider: "openai-compatible",
    baseUrl: "/llm-gateway/api",
    // apiKey: "<your-gateway-key-if-required>",
    model: test.llmGateway?.model || "gpt-4o-mini",
    messages,
  };

  res.json({
    ok: true,
    replay: payload,
    info: {
      ragIncluded: includeRag,
      ragGloballyEnabled: cfg.ragEnabled === true,
      ragRequested,
      ragDisabledPerTest,
    },
  });
});

export default router;
