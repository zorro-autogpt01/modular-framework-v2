import fetch from "node-fetch";
import { logError, logDebug } from "./logger.js";

function joinBase(base, path) {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}${path}`;
}

function toAbsolute(baseUrl) {
  if (/^https?:\/\//i.test(baseUrl)) return baseUrl;
  const edge = process.env.EDGE_BASE;
  if (!edge) throw new Error("EDGE_BASE is required to call gateway via edge");
  const e = edge.endsWith("/") ? edge.slice(0, -1) : edge;
  return e + baseUrl;
}

function extractContent(j) {
  // Gateway canonical shape
  if (typeof j?.content === "string") return j.content;

  // OpenAI chat-completions-like shape
  if (j?.choices?.[0]?.message?.content) return j.choices[0].message.content;

  // Responses API pass-through shapes we might get
  if (Array.isArray(j?.output_text)) return j.output_text.join("");
  if (j?.message?.content) return j.message.content;
  if (typeof j?.text === "string") return j.text;

  // When gateway returned { content, raw }, ensure we try raw as well
  const raw = j?.raw;
  if (raw) {
    if (typeof raw.content === "string") return raw.content;
    if (raw?.choices?.[0]?.message?.content) return raw.choices[0].message.content;
    if (Array.isArray(raw?.output_text)) return raw.output_text.join("");
    if (raw?.message?.content) return raw.message.content;
    if (typeof raw?.text === "string") return raw.text;
  }

  return "";
}

export async function chatCompletion({ baseUrl, headers = {}, model, messages = [], stream = false, temperature, max_tokens }) {
  const url = joinBase(toAbsolute(baseUrl), "/v1/chat");
  const mergedHeaders = { "Content-Type": "application/json", ...headers };
  if (process.env.GATEWAY_KEY && !mergedHeaders.Authorization) {
    mergedHeaders.Authorization = `Bearer ${process.env.GATEWAY_KEY}`;
  }

  const body = {
    model,
    messages,
    stream: false, // aggregate non-stream; SSE handled elsewhere when needed
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof max_tokens === "number" ? { max_tokens } : {})
  };

  logDebug("LLM Gateway request", {
    url,
    model,
    headerKeys: Object.keys(mergedHeaders || {}),
    messageCount: Array.isArray(messages) ? messages.length : 0
  }, "llm");

  let response;
  const t0 = Date.now();
  try {
    response = await fetch(url, { method: "POST", headers: mergedHeaders, body: JSON.stringify(body) });
  } catch (error) {
    logError("LLM Gateway network error", { error: error.message, url }, "llm");
    throw new Error(`Gateway network error: ${error.message}`);
  }

  const responseText = await response.text();
  const latencyMs = Date.now() - t0;

  if (!response.ok) {
    logError("LLM Gateway error response", {
      status: response.status,
      statusText: response.statusText,
      latencyMs,
      responsePreview: responseText.slice(0, 500)
    }, "llm");

    let errorMessage = `Gateway ${response.status}: ${response.statusText}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.error?.message) {
        errorMessage = `Gateway ${response.status}: ${errorJson.error.message}`;
      } else if (typeof errorJson?.message === "string") {
        errorMessage = `Gateway ${response.status}: ${errorJson.message}`;
      }
    } catch {
      const firstLine = responseText.split("\n")[0].slice(0, 100);
      if (firstLine) errorMessage = `Gateway ${response.status}: ${firstLine}`;
    }
    throw new Error(errorMessage);
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (error) {
    logError("Failed to parse LLM Gateway response as JSON", {
      error: error.message,
      responsePreview: responseText.slice(0, 500)
    }, "llm");
    throw new Error(`Gateway returned invalid JSON: ${error.message}`);
  }

  const content = extractContent(json);
  logDebug("LLM Gateway success", { latencyMs, contentLength: content?.length ?? 0 }, "llm");

  return { raw: json, content };
}
