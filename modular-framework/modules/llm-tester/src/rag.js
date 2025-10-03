import fetch from "node-fetch";
import { logError, logDebug } from "./logger.js";

function rag(path) {
  const base = process.env.EDGE_BASE;
  if (!base) throw new Error("EDGE_BASE is required");
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + "/rag" + path;
}

export async function retrieve({ question, top_k = 4 }) {
  logDebug("RAG retrieve request", { question, top_k }, "rag");
  
  let response;
  try {
    response = await fetch(rag("/retrieve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: question, top_k, dedupe_by: "file" })
    });
  } catch (error) {
    logError("RAG network error", { error: error.message }, "rag");
    throw new Error(`RAG network error: ${error.message}`);
  }
  
  const responseText = await response.text();
  
  if (!response.ok) {
    logError("RAG error response", {
      status: response.status,
      responsePreview: responseText.slice(0, 500)
    }, "rag");
    
    let errorMessage = `RAG retrieve ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.message) {
        errorMessage = `RAG retrieve ${response.status}: ${errorJson.message}`;
      }
    } catch {
      const firstLine = responseText.split('\n')[0].slice(0, 100);
      if (firstLine) {
        errorMessage = `RAG retrieve ${response.status}: ${firstLine}`;
      }
    }
    throw new Error(errorMessage);
  }
  
  let json;
  try {
    json = JSON.parse(responseText);
  } catch (error) {
    logError("Failed to parse RAG response as JSON", {
      error: error.message,
      responsePreview: responseText.slice(0, 500)
    }, "rag");
    throw new Error(`RAG returned invalid JSON: ${error.message}`);
  }
  
  const snippets = (json.snippets || []).map(s => s.text).filter(Boolean);
  
  logDebug("RAG retrieve success", { 
    snippetCount: snippets.length,
    totalLength: snippets.join("").length 
  }, "rag");
  
  return snippets.join("\n---\n");
}