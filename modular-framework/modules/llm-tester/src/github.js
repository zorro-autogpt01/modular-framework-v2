import fetch from "node-fetch";
import { logError, logDebug } from "./logger.js";

function edge(path) {
  const base = process.env.EDGE_BASE;
  if (!base) throw new Error("EDGE_BASE is required");
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + "/api/github-hub/api" + path;
}

export async function getFile({ path: filePath, branch = "main" }) {
  const url = new URL(edge("/file"));
  url.searchParams.set("path", filePath);
  url.searchParams.set("branch", branch);
  
  logDebug("Fetching file from GitHub Hub", { path: filePath, branch }, "github");
  
  let response;
  try {
    response = await fetch(url.toString());
  } catch (error) {
    logError("GitHub Hub network error", { error: error.message, url: url.toString() }, "github");
    throw new Error(`GitHub Hub network error: ${error.message}`);
  }
  
  // Read response as text first
  const responseText = await response.text();
  
  if (!response.ok) {
    logError("GitHub Hub error response", { 
      status: response.status,
      statusText: response.statusText,
      responsePreview: responseText.slice(0, 500)
    }, "github");
    
    // Try to parse as JSON for better error message
    let errorMessage = `GitHub Hub ${response.status}: ${response.statusText}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.message) {
        errorMessage = `GitHub Hub ${response.status}: ${errorJson.message}`;
      }
    } catch {
      // If not JSON, use first line of text response
      const firstLine = responseText.split('\n')[0].slice(0, 100);
      if (firstLine) {
        errorMessage = `GitHub Hub ${response.status}: ${firstLine}`;
      }
    }
    throw new Error(errorMessage);
  }
  
  // Parse successful response
  let json;
  try {
    json = JSON.parse(responseText);
  } catch (error) {
    logError("Failed to parse GitHub Hub response as JSON", {
      error: error.message,
      responsePreview: responseText.slice(0, 500)
    }, "github");
    throw new Error(`GitHub Hub returned invalid JSON: ${error.message}`);
  }
  
  logDebug("Successfully fetched file from GitHub Hub", { 
    path: filePath,
    contentLength: json.decoded_content?.length || 0 
  }, "github");
  
  return json.decoded_content || "";
}

export async function putFile({ path: filePath, content, message, branch = "main", sha }) {
  logDebug("Putting file to GitHub Hub", { path: filePath, branch }, "github");
  
  let response;
  try {
    response = await fetch(edge("/file"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, message, content, branch, sha })
    });
  } catch (error) {
    logError("GitHub Hub put network error", { error: error.message }, "github");
    throw new Error(`GitHub Hub put network error: ${error.message}`);
  }
  
  const responseText = await response.text();
  
  if (!response.ok) {
    logError("GitHub Hub put error response", {
      status: response.status,
      responsePreview: responseText.slice(0, 500)
    }, "github");
    
    let errorMessage = `GitHub Hub put ${response.status}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson?.message) {
        errorMessage = `GitHub Hub put ${response.status}: ${errorJson.message}`;
      }
    } catch {
      const firstLine = responseText.split('\n')[0].slice(0, 100);
      if (firstLine) {
        errorMessage = `GitHub Hub put ${response.status}: ${firstLine}`;
      }
    }
    throw new Error(errorMessage);
  }
  
  let json;
  try {
    json = JSON.parse(responseText);
  } catch (error) {
    logError("Failed to parse GitHub Hub put response as JSON", {
      error: error.message
    }, "github");
    throw new Error(`GitHub Hub put returned invalid JSON: ${error.message}`);
  }
  
  return json;
}