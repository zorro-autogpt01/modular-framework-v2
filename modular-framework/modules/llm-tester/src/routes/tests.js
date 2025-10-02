import { Router } from "express";
import { Storage } from "../storage.js";
import { chatCompletion } from "../llm.js";
import { getFile } from "../github.js";
import { retrieve } from "../rag.js";
import { openSSE, send, close } from "../sse.js";
import { buildMessages, assertAll } from "../util.js";
import { notifyWebhooks } from "../webhook.js";

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
    // Artifact (GitHub Hub)
    let artifactContent = "";
    if (test.input?.artifact?.path) {
      if (doStream) send(res, { type: "artifact", path: test.input.artifact.path });
      artifactContent = await getFile(test.input.artifact);
    }

    // RAG (optional)
    let ragContext = "";
    if (test.context?.ragQuery?.question) {
      if (doStream) send(res, { type: "rag", status: "retrieving" });
      ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 });
    }

    const messages = buildMessages(test.input?.messages, {
      artifactContent,
      ragContext,
      staticContext: test.context?.static
    });

    // Call LLM via Gateway
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

    // Assertions (regex/exact/count/safety)
    const { ok: baseOk, results } = assertAll({ completion: content, test });

    // Semantic judge
    const judgeResults = [];
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
        judgeResults.push({ criterion: c.name, score, ok: pass });
        if (got?.why) judgeExplanations.push({ criterion: c.name, why: got.why });
      }
    }

    const ok = results.every(r => r.ok);
    const run = {
      runId: "run_" + crypto.randomUUID(),
      testId: test.id,
      suite: test.suite,
      ok,
      startedAt,
      endedAt: new Date().toISOString(),
      latencyMs,
      assertions: results,
      artifacts: { prompt: messages, completion: content, judgeExplanations }
    };

    Storage.saveRun(run);

    // Webhooks
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

export default router;
