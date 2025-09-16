import { getGlobal, getProfiles, getActiveName } from './storage.js';
import { parseStream } from './sse.js';
import { getEl, setBusy, addMsg, detectBasePath } from './ui.js';

const state = { controller:null, messages:[] };

export async function summarizeConversation() {
  if (!state.messages.length) return;

  const g = getGlobal();
  const active = getProfiles().find(p => p.name === getActiveName()) || {};
  const system = `
    You are a helpful assistant. Summarize the conversation so far for a reader who hasn’t seen it.
    Produce a concise brief with:
    - Goals or questions
    - Key decisions/trade-offs
    - Action items and open questions
    Keep it under ~200 words.
  `.trim();

  // Use only the last N messages if you want to cap context size
  const MAX_MSGS = 40;
  const history = state.messages.slice(-MAX_MSGS);

  const msgs = [{ role:'system', content: system }, ...history];

  const basePath = detectBasePath();
  const apiUrl = `${basePath}api/chat`;

  // Render a placeholder bubble labelled "Summary"
  const placeholder = document.createElement('div');
  placeholder.className = 'msg assistant';
  placeholder.textContent = '🔎 Summarizing…';
  const msgsDiv = getEl('msgs'); msgsDiv.appendChild(placeholder); msgsDiv.scrollTop = msgsDiv.scrollHeight;

  setBusy(true);
  const controller = new AbortController(); state.controller = controller;
  try{
    const provider    = active.provider ?? g.provider;
    const baseUrl     = active.baseUrl  ?? g.baseUrl;
    const apiKey      = active.apiKey   ?? g.apiKey;
    const model       = active.model    ?? g.model;
    const temperature = active.temperature ?? g.temperature;
    const max_tokens  = active.max_tokens ?? g.max_tokens;

    const resp = await fetch(apiUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ provider, baseUrl, apiKey, model, messages: msgs, temperature, max_tokens, stream:true }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP error');

    placeholder.textContent = ''; // clear "Summarizing…"
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const pump = parseStream(
      (d)=> { placeholder.textContent += d; },
      ()=> { state.messages.push({ role:'assistant', content: placeholder.textContent }); },
      (m)=> { placeholder.textContent += `\n[error] ${m}`; }
    );
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) pump(decoder.decode(value, { stream:true }));
    }
  } catch (e) {
    placeholder.textContent += `\n[stopped] ${e.message}`;
  } finally {
    setBusy(false); state.controller=null;
  }
}

export function clearChat(){ state.messages = []; const m = getEl('msgs'); if (m) m.innerHTML=''; }
export function stop(){ if (state.controller) state.controller.abort(); }

export async function send(buildOverrides) {
  const input = getEl('input'); const text = input.value.trim(); if (!text) return;

  const g = getGlobal();
  const profiles = getProfiles();
  const active = profiles.find(p => p.name === getActiveName()) || {};
  const o = buildOverrides();

  const provider    = o.provider    ?? active.provider ?? g.provider;
  const baseUrl     = o.baseUrl     ?? active.baseUrl  ?? g.baseUrl;
  const apiKey      = active.apiKey ?? g.apiKey;
  const model       = o.model       ?? active.model    ?? g.model;
  const temperature = o.temperature ?? active.temperature ?? g.temperature;
  const max_tokens  = o.max_tokens  ?? active.max_tokens  ?? g.max_tokens;
  const system      = o.system      || active.systemPrompt || '';

  const msgs = [];
  if (system) msgs.push({ role:'system', content: system });
  msgs.push(...state.messages, { role:'user', content: text });

  addMsg('user', text);
  const placeholder = document.createElement('div');
  placeholder.className = 'msg assistant'; placeholder.textContent = '';
  const msgsDiv = getEl('msgs');
  msgsDiv.appendChild(placeholder); msgsDiv.scrollTop = msgsDiv.scrollHeight;
  state.messages.push({ role:'user', content: text });
  input.value='';

  // Build prefix-aware API URL
  const basePath = detectBasePath(); // e.g. "/" or "/modules/llm-chat/"
  const apiUrl = `${basePath}api/chat`;

  state.controller = new AbortController();
  setBusy(true);
  try{
    const resp = await fetch(apiUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ provider, baseUrl, apiKey, model, messages: msgs, temperature, max_tokens, stream:true }),
      signal: state.controller.signal
    });
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP error');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const pump = parseStream(
      (d)=> { placeholder.textContent += d; },
      ()=> { state.messages.push({ role:'assistant', content: placeholder.textContent }); },
      (m)=> { placeholder.textContent += `\n[error] ${m}`; }
    );
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) pump(decoder.decode(value, { stream:true }));
    }
  } catch (e) {
    placeholder.textContent += `\n[stopped] ${e.message}`;
  } finally {
    setBusy(false); state.controller=null;
  }
}
