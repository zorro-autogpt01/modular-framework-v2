import { Router } from "express";
import { Storage } from "../storage.js";
import { chatCompletion } from "../llm.js";
import { getFile } from "../github.js";
import { retrieve } from "../rag.js";
import { openSSE, send, close } from "../sse.js";
import { buildMessages, assertAll } from "../util.js";
import { notifyWebhooks } from "../webhook.js";
import { randomUUID } from "node:crypto";
import { logWarn, logInfo, logError, logDebug } from "../logger.js";
import fs from "node:fs";
import path from "node:path";

const router = Router();

/** Build a simple text file tree starting at `root`.
 *  Options: maxDepth (default 4), maxFiles (default 2000), includeHidden (default false), ignore (array of dir/file globs-ish)
 */
function buildLocalFileTree(root, {
  maxDepth = 4,
  maxFiles = 2000,
  includeHidden = false,
  ignore = ["node_modules", ".git", "data", "dist", "build", ".next", "coverage", ".cache"]
} = {}) {
  const start = path.resolve(root);
  const lines = [];
  let count = 0;

  const isIgnored = (name) => {
    if (!includeHidden && name.startsWith(".")) return true;
    return ignore.some(ig => name === ig || name.endsWith("/" + ig));
  };

  function walk(cur, depth, relPrefix = "") {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort dirs first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const e of entries) {
      if (count >= maxFiles) break;
      const name = e.name;
      if (isIgnored(name)) continue;
      const abs = path.join(cur, name);
      const rel = path.join(relPrefix, name);
      const prefix = depth > 0 ? "  ".repeat(depth - 1) : "";
      lines.push(`- ${prefix}${rel}`);
      count++;
      if (e.isDirectory()) {
        walk(abs, depth + 1, rel);
      }
    }
  }

  walk(start, 1, "");
  return {
    tree: lines.join("\n"),
    count,
  };
}

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
  const rid = req.id;
  const test = Storage.getTest(req.params.id);
  if (!test) return res.status(404).json({ error: "not_found" });

  logInfo("Test execute <-", { rid, testId: test.id, suite: test.suite, kind: test.kind }, "tests");

  const doStream = String(req.query.stream || "").toLowerCase() === "true" || req.headers.accept?.includes("text/event-stream");
  const startedAt = new Date().toISOString();

  if (doStream) openSSE(res), send(res, { type: "phase", phase: "prepare", testId: test.id });

  try {
    // Artifact (tolerant)
    let artifactContent = "";
    if (test.input?.artifact) {
      const art = test.input.artifact;
      if (art.source === "local_tree") {
        // Dynamic file tree from local FS
        // Root precedence: artifact.root || process.env.REPO_ROOT || process.cwd()
        const root = path.resolve(art.root || process.env.REPO_ROOT || process.cwd());
        const maxDepth = Number(art.maxDepth || 4);
        const maxFiles = Number(art.maxFiles || 2000);
        const includeHidden = Boolean(art.includeHidden || false);
        const ignore = Array.isArray(art.ignore) ? art.ignore : undefined;

        if (doStream) send(res, { type: "artifact", source: "local_tree", root, maxDepth, maxFiles });
        const t0 = Date.now();
        try {
          const { tree, count } = buildLocalFileTree(root, { maxDepth, maxFiles, includeHidden, ignore });
          artifactContent = tree;
          logInfo("Local tree built", { rid, root, count, len: artifactContent.length, ms: Date.now() - t0 }, "artifact");
        } catch (e) {
          logWarn("Local tree failed, continuing", { rid, root, error: e.message }, "artifact");
          if (art.fallback) {
            artifactContent = String(art.fallback);
            logWarn("Artifact fallback used (local_tree)", { rid, len: artifactContent.length }, "artifact");
          } else if (art.optional) {
            artifactContent = "";
            logWarn("Artifact optional -> empty (local_tree)", { rid }, "artifact");
          } else {
            artifactContent = "Repository tree unavailable.";
            logWarn("Artifact placeholder used (local_tree)", { rid }, "artifact");
          }
        }
      } else if (art.path) {
        // GitHub Hub (existing)
        try {
          if (doStream) send(res, { type: "artifact", path: art.path });
          const t0 = Date.now();
          artifactContent = await getFile(art);
          logInfo("Artifact fetched", { rid, path: art.path, len: artifactContent.length, ms: Date.now() - t0 }, "artifact");
        } catch (e) {
          logWarn("Artifact fetch failed, continuing", { rid, path: art.path, error: e.message }, "artifact");
          if (art.fallback) {
            artifactContent = String(art.fallback);
            logWarn("Artifact fallback used", { rid, path: art.path, len: artifactContent.length }, "artifact");
          } else if (art.optional) {
            artifactContent = "";
            logWarn("Artifact optional -> empty", { rid, path: art.path }, "artifact");
          } else {
            artifactContent = "Placeholder: artifact not available.";
            logWarn("Artifact placeholder used", { rid, path: art.path }, "artifact");
          }
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
      const tr = Date.now();
      try {
        ragContext = await retrieve({ question: test.context.ragQuery.question, top_k: 4 });
        logInfo("RAG retrieved", { rid, used: true, len: ragContext.length, ms: Date.now() - tr }, "rag");
      } catch (e) {
        logWarn("RAG retrieve failed, continuing", { rid, error: e.message }, "rag");
      }
    } else {
      if (doStream) send(res, { type: "rag", status: "skipped", reason: !cfg.ragEnabled ? "global_disabled" : (ragDisabledPerTest ? "test_disabled" : "not_requested") });
      logInfo("RAG skipped", { rid, global: cfg.ragEnabled, requested: ragRequested, testDisabled: ragDisabledPerTest }, "rag");
    }
    const ragUsed = Boolean(canUseRag && ragContext);

    const messages = buildMessages(test.input?.messages, {
      artifactContent,
      ragContext,
      staticContext: test.context?.static
    });

    logDebug("Built messages", { rid, count: messages.length, approxChars: messages.map(m=>m.content||'').join('').length }, "tests");

    if (doStream) send(res, { type: "llm", model: test.llmGateway?.model || "unknown" });

    const t0 = Date.now();
    const { content } = await chatCompletion({
      baseUrl: test.llmGateway?.baseUrl || "/api/v1/gateway/",
      headers: test.llmGateway?.headers || {},
      model: test.llmGateway?.model,
      messages,
      stream: false
    });
    const latencyMs = Date.now() - t0;
    logInfo("LLM completion", { rid, model: test.llmGateway?.model, latencyMs, contentLength: (content||'').length }, "tests");

    const { ok: baseOk, results } = assertAll({ completion: content, test });
    logInfo("Assertions evaluated", {
      rid,
      count: results.length,
      passCount: results.filter(r=>r.ok).length,
      failCount: results.filter(r=>!r.ok).length
    }, "tests");

    let judgeExplanations = [];
    if (test.assert?.semantic?.criteria?.length) {
      const j = test.assert.semantic;
      const judgePrompt = [
        { role: "system", content: `You are a strict evaluator. Rubric:\n${j.rubric || ""}\nReturn JSON exactly: {"scores":[{"criterion":"","score":0..1,"why":""},...]}` },
        { role: "user", content: `Candidate output:\n${content}\n\nNow evaluate.` }
      ];
      const tj = Date.now();
      try {
        const { content: judgeOut } = await chatCompletion({
          baseUrl: j.judge.baseUrl || test.llmGateway?.baseUrl || "/api/v1/gateway/",
          headers: j.judge.headers || test.llmGateway?.headers || {},
          model: j.judge.model || test.llmGateway?.model,
          messages: judgePrompt
        });
        logDebug("Judge completion", { rid, latencyMs: Date.now() - tj, outLen: (judgeOut||'').length }, "tests");
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
      } catch (e) {
        logWarn("Judge call failed, skipping semantic evaluation", { rid, error: e.message }, "tests");
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
    logInfo("Run saved", { rid, runId: run.runId, ok, latencyMs }, "tests");

    await notifyWebhooks(Storage.listWebhooks(), ok ? "run.finished" : "run.failed", run);

    if (doStream) {
      send(res, { type: "assertions", results });
      send(res, { type: "done", ok, latencyMs, runId: run.runId });
      return close(res);
    } else {
      return res.json(run);
    }
  } catch (e) {
    logError("Test execute error", { rid, error: e.message, stack: e.stack, testId: test?.id }, "tests");
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
  } else if (test.input?.artifact?.source === "local_tree") {
    // For replay we can regenerate the tree too
    const root = path.resolve(test.input.artifact.root || process.env.REPO_ROOT || process.cwd());
    const { tree } = buildLocalFileTree(root, {
      maxDepth: Number(test.input.artifact.maxDepth || 4),
      maxFiles: Number(test.input.artifact.maxFiles || 2000),
      includeHidden: Boolean(test.input.artifact.includeHidden || false),
      ignore: Array.isArray(test.input.artifact.ignore) ? test.input.artifact.ignore : undefined
    });
    artifactContent = tree;
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
    baseUrl: "/api/v1/gateway/",
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
