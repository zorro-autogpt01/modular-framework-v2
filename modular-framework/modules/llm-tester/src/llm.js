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

export async function chatCompletion({ baseUrl, headers = {}, model, messages, stream = false }) {
  const url = joinBase(toAbsolute(baseUrl), "/v1/chat/completions");
  const mergedHeaders = { "Content-Type": "application/json", ...headers };
  if (process.env.GATEWAY_KEY && !mergedHeaders.Authorization) {
    mergedHeaders.Authorization = `Bearer ${process.env.GATEWAY_KEY}`;
  }
  const body = { model, messages, stream: false }; // we aggregate; SSE handled by our module
  
  logDebug("LLM Gateway request", { url, model, messageCount: messages.length }, "llm");
  
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: mergedHeaders, body: JSON.stringify(body) });
  } catch (error) {
    logError("LLM Gateway network error", { error: error.message, url }, "llm");
    throw new Error(`Gateway network error: ${error.message}`);
  }
  
  // Read response body as text first
  const responseText = await response.text();
  
  if (!response.ok) {
    logError("LLM Gateway error response", { 
      status: response.status, 
      statusText: response.statusText,
      responsePreview: responseText.slice(0, 500)
    }, "llm");
    
    // Try to parse as JSON for better error message
    let errorMessage = `Gateway ${response.status}: ${response.statusText}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.error?.message) {
        errorMessage = `Gateway ${response.status}: ${errorJson.error.message}`;
      }
    } catch {
      // If not JSON, use first line of text response
      const firstLine = responseText.split('\n')[0].slice(0, 100);
      if (firstLine) {
        errorMessage = `Gateway ${response.status}: ${firstLine}`;
      }
    }
    throw new Error(errorMessage);
  }
  
  // Parse successful response
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
  
  const content = json?.choices?.[0]?.message?.content ?? "";
  logDebug("LLM Gateway success", { contentLength: content.length }, "llm");
  
  return { raw: json, content };
}
