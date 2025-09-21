import { getGlobal, getProfiles, getActiveName } from './storage.js';
import { parseStream } from './sse.js';
import { getEl, setBusy, addMsg, detectBasePath } from './ui.js';

const state = { 
  controller: null, 
  messages: [],
  conversationId: null,
  ragEnabled: false,
  ragContext: null
};

// LLM Gateway URL (from window or localStorage). Ensure it ends with /api
function getGatewayUrl() {
  let val = window.LLM_GATEWAY_URL || localStorage.getItem('llmGatewayUrl') || '';
  if (!val) return '';
  val = val.trim().replace(/\/+$/, '');
  if (!/\/api$/i.test(val)) val += '/api';
  return val;
}

// RAG Service configuration
const RAG_SERVICE_URL = window.RAG_SERVICE_URL || '/rag';
function getRagUrl() {
  return window.RAG_SERVICE_URL || localStorage.getItem('ragServiceUrl') || '/rag';
}

// Small helper to read tags from the input
function readConvTags() {
  const raw = getEl('convTags')?.value || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function displayMemories(snippets) {
  if (!snippets || !snippets.length) return;
  const msgsDiv = getEl('msgs');
  const memDiv = document.createElement('div');
  memDiv.className = 'sources'; // reuse styling
  memDiv.innerHTML = `
    <details open>
      <summary>🧠 Memories used (${snippets.length})</summary>
      ${snippets.map(s => `<div class="source-item"><div style="white-space:pre-wrap">${s}</div></div>`).join('')}
    </details>
  `;
  msgsDiv.appendChild(memDiv);
}


// Initialize or continue conversation
export async function initConversation() {
  // Get or create conversation ID
  if (!state.conversationId) {
    state.conversationId = localStorage.getItem('currentConversationId') || 
                          `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('currentConversationId', state.conversationId);
  }
  
  // Update UI with conversation ID
  const convIdEl = getEl('convId');
  if (convIdEl) convIdEl.textContent = `ID: ${state.conversationId.substr(0, 12)}...`;
  
  // Try to load conversation context from RAG if enabled
  if (state.ragEnabled) {
    try {
      const response = await fetch(`${getRagUrl()}/conversation/${state.conversationId}`);
      if (response.ok) {
        state.ragContext = await response.json();
        
        // Restore recent messages if any
        if (state.ragContext.recent_messages && state.ragContext.recent_messages.length > 0) {
          state.messages = state.ragContext.recent_messages;
          displayConversationHistory();
        }
      }
    } catch (error) {
      console.log('No previous conversation found or RAG not available');
    }
  }
}

// Display conversation history
function displayConversationHistory() {
  const msgsDiv = getEl('msgs');
  if (!msgsDiv) return;
  
  msgsDiv.innerHTML = '';
  state.messages.forEach(msg => {
    const el = document.createElement('div');
    el.className = `msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
    el.textContent = msg.content;
    msgsDiv.appendChild(el);
  });
  msgsDiv.scrollTop = msgsDiv.scrollHeight;
}


// Query RAG system
async function queryRAG(question, searchCode = true, searchDocs = true) {
  try {
    const response = await fetch(`${getRagUrl()}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        search_code: searchCode,
        search_docs: searchDocs
      }),
      timeout: 5000
    });
    
    if (!response.ok) throw new Error('RAG query failed');
    return await response.json();
  } catch (error) {
    console.warn('RAG query failed:', error);
    return null;
  }
}

// Save conversation to RAG
export async function saveConversation() {
  if (!state.conversationId) {
    alert('No conversation ID yet.');
    return;
  }
  if (state.messages.length === 0) {
    alert('Nothing to save yet.');
    return;
  }
  
  try {
    const tags = readConvTags();
    const resp = await fetch(`${getRagUrl()}/conversation/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        messages: state.messages,
        metadata: {
          profile: getActiveName(),
          timestamp: new Date().toISOString(),
          message_count: state.messages.length,
          tags
        }
      })
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Save failed: ${resp.status} ${text}`);
    }
    console.log('Conversation saved to RAG');
    
    // Show save indicator
    const saveIndicator = getEl('saveIndicator');
    if (saveIndicator) {
      saveIndicator.textContent = '✓ Saved';
      saveIndicator.style.display = 'inline';
      setTimeout(() => { saveIndicator.style.display = 'none'; }, 2000);
    }
  } 
  catch (error) {
    console.error('Failed to save conversation:', error);
    alert(`Failed to save conversation: ${error.message}`);
}
}

// Search past conversations
export async function searchPastConversations() {
  const searchModal = getEl('searchModal');
  const searchInput = getEl('searchConvInput');
  const searchResults = getEl('searchResults');
  
  if (!searchModal || !searchInput || !searchResults) return;
  
  searchModal.style.display = 'block';
  searchInput.focus();
  
  searchInput.oninput = async (e) => {
    const query = e.target.value;
    if (query.length < 3) {
      searchResults.innerHTML = '<div class="muted">Type at least 3 characters to search...</div>';
      return;
    }
    
    try {
      const response = await fetch(`${getRagUrl()}/conversation/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 5 })
      });
      
      const data = await response.json();
      
      if (data.results && data.results.length > 0) {
        searchResults.innerHTML = data.results.map(r => `
          <div class="search-result" onclick="loadConversation('${r.conversation_id}')">
            <div class="search-result-content">${r.content.substring(0, 200)}...</div>
            <div class="search-result-meta">
              <span class="muted">ID: ${r.conversation_id.substr(0, 12)}...</span>
              <span class="muted">${r.timestamp}</span>
              <span class="score">${(r.score * 100).toFixed(0)}% relevant</span>
            </div>
          </div>
        `).join('');
      } else {
        searchResults.innerHTML = '<div class="muted">No results found</div>';
      }
    } catch (error) {
      searchResults.innerHTML = '<div class="muted">Search failed</div>';
    }
  };
}

// Load a specific conversation
window.loadConversation = async function(conversationId) {
  if (state.messages.length > 0) {
    await saveConversation();
  }
  
  state.conversationId = conversationId;
  localStorage.setItem('currentConversationId', conversationId);
  
  await initConversation();
  
  const searchModal = getEl('searchModal');
  if (searchModal) searchModal.style.display = 'none';
};

// Start new conversation
export function startNewConversation() {
  if (state.messages.length > 0) {
    saveConversation();
  }
  
  state.messages = [];
  state.conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  state.ragContext = null;
  localStorage.setItem('currentConversationId', state.conversationId);
  
  const msgsDiv = getEl('msgs');
  if (msgsDiv) msgsDiv.innerHTML = '';
  
  const convIdEl = getEl('convId');
  if (convIdEl) convIdEl.textContent = `ID: ${state.conversationId.substr(0, 12)}...`;
  
  updateMessageCount();
}

// Update message count display
function updateMessageCount() {
  const countEl = getEl('convMsgCount');
  if (countEl) countEl.textContent = `${state.messages.length} messages`;
}

// Display sources from RAG
function displaySources(sources) {
  if (!sources || sources.length === 0) return;
  
  const msgsDiv = getEl('msgs');
  const sourcesDiv = document.createElement('div');
  sourcesDiv.className = 'sources';
  sourcesDiv.innerHTML = `
    <details>
      <summary>📚 Sources (${sources.length})</summary>
      ${sources.map(s => `
        <div class="source-item">
          ${s.type === 'code' 
            ? `📝 ${s.repo || 'repo'}/${s.file || s.source}` 
            : `📄 ${s.source}`}
          <span class="score">${(s.score * 100).toFixed(0)}% relevant</span>
        </div>
      `).join('')}
    </details>
  `;
  msgsDiv.appendChild(sourcesDiv);
}

export async function summarizeConversation() {
  if (!state.messages.length) return;

  const g = getGlobal();
  const active = getProfiles().find(p => p.name === getActiveName()) || {};
  const system = `
    You are a helpful assistant. Summarize the conversation so far for a reader who hasn't seen it.
    Produce a concise brief with:
    - Goals or questions
    - Key decisions/trade-offs
    - Action items and open questions
    Keep it under ~200 words.
  `.trim();

  const MAX_MSGS = 40;
  const history = state.messages.slice(-MAX_MSGS);

  const msgs = [{ role:'system', content: system }, ...history];

  const basePath = detectBasePath();
  const gw = getGatewayUrl();
  const apiUrl = gw ? `${gw}/v1/chat` : `${basePath}api/chat`;

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
      body: JSON.stringify(
        gw
          ? { model, messages: msgs, temperature, max_tokens, stream:true,
              metadata: { source:'llm-chat', conversationId: state.conversationId } }
          : { provider, baseUrl, apiKey, model, messages: msgs, temperature, max_tokens, stream:true }
      ),      signal: controller.signal
    });
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP error');

    placeholder.textContent = '';
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

export function clearChat(){ 
  state.messages = []; 
  const m = getEl('msgs'); 
  if (m) m.innerHTML=''; 
  updateMessageCount();
}

export function stop(){ 
  if (state.controller) state.controller.abort(); 
}

export async function send(buildOverrides) {
  const input = getEl('input'); 
  const text = input.value.trim(); 
  if (!text) return;

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

  // Check if RAG is enabled
  const useRAG = getEl('useRAG')?.checked || false;
  const ragOnly = getEl('ragOnly')?.checked || false;
  const useMemories = getEl('useMemories')?.checked || false;
  state.ragEnabled = useRAG;

  let ragResponse = null;
  let enhancedSystem = system;
  let memorySnippets = [];

 // ----- Fetch tag-scoped memories across conversations -----
 if (useMemories) {
   try {
     const tags = readConvTags();
     const resp = await fetch(`${getRagUrl()}/conversation/search`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         query: text,
         limit: 5,
         profile: getActiveName(),
         tags
       })
     });
     if (resp.ok) {
       const data = await resp.json();
       const results = data.results || [];
       // Keep short snippets to avoid prompt bloat
       memorySnippets = results
         .map(r => (r.content || '').slice(0, 400))
         .filter(Boolean)
         .slice(0, 3);
     }
   } catch (e) {
     console.warn('Memory search failed', e);
   }
 }


  // Query RAG if enabled
  if (useRAG) {
    const ragIndicator = getEl('ragIndicator');
    if (ragIndicator) {
      ragIndicator.textContent = '🔍 Searching knowledge base...';
      ragIndicator.style.display = 'inline';
    }

    ragResponse = await queryRAG(text);
    
    if (ragIndicator) {
      ragIndicator.style.display = 'none';
    }

    if (ragResponse && ragResponse.answer) {
      // If RAG-only mode, return RAG answer directly
      if (ragOnly) {
        addMsg('user', text);
        const msgsDiv = getEl('msgs');

        // Show the RAG answer
        const ragMsg = document.createElement('div');
        ragMsg.className = 'msg assistant';
        ragMsg.innerHTML = `<span class="rag-badge">RAG</span> ${ragResponse?.answer || ''}`;
        msgsDiv.appendChild(ragMsg);

        // Panels: RAG sources + tagged memories (if enabled)
        if (ragResponse?.sources) displaySources(ragResponse.sources);
        if (useMemories && memorySnippets.length) displayMemories(memorySnippets);

        // Persist both in the local transcript
        state.messages.push({ role:'user', content: text });
        const storedAnswer = (ragResponse?.answer || '') + (useMemories && memorySnippets.length ? `\n\n[memories used: ${memorySnippets.length}]` : '');
        state.messages.push({ role:'assistant', content: storedAnswer });

        input.value = '';
        updateMessageCount();

        if (state.messages.length % 10 === 0) await saveConversation();
        return;
      }

      // Enhance system prompt with RAG context
      enhancedSystem = `${system ? system + '\n\n' : ''}You have access to the following information from the knowledge base:

${ragResponse.answer}

Sources consulted:
${ragResponse.sources ? ragResponse.sources.map(s => `- ${s.type === 'code' ? `Code: ${s.file || s.source}` : `Document: ${s.source}`}`).join('\n') : 'No sources'}

Use this information to answer the user's question accurately. If the knowledge base information fully answers the question, use it. If you need to add context beyond what's in the knowledge base, clearly indicate what comes from the knowledge base versus your general knowledge.`;
    }
  }

  const msgs = [];
  if (enhancedSystem) msgs.push({ role:'system', content: enhancedSystem });

  // Inject memories (if any)
 if (memorySnippets.length) {
   msgs.push({
     role: 'system',
     content:
       "Relevant info from prior tagged conversations:\n" +
       memorySnippets.map(s => `- ${s}`).join('\n')
   });
 }
  
  // Add conversation context from RAG if available
  if (state.ragContext?.relevant_history?.length > 0) {
    const historyContext = state.ragContext.relevant_history
      .map(h => h.content)
      .join('\n---\n');
    msgs.push({
      role: 'system',
      content: `Relevant context from earlier in this conversation:\n${historyContext}`
    });
  }
  
  msgs.push(...state.messages, { role:'user', content: text });

  addMsg('user', text);
  const placeholder = document.createElement('div');
  placeholder.className = 'msg assistant'; 
  placeholder.textContent = '';
  const msgsDiv = getEl('msgs');
  msgsDiv.appendChild(placeholder); 
  msgsDiv.scrollTop = msgsDiv.scrollHeight;
  state.messages.push({ role:'user', content: text });
  input.value='';

  const basePath = detectBasePath();
  const gw = getGatewayUrl();
  const apiUrl = gw ? `${gw}/v1/chat` : `${basePath}api/chat`;

  state.controller = new AbortController();
  setBusy(true);
  try{
    const resp = await fetch(apiUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(
        gw
          ? { model, messages: msgs, temperature, max_tokens, stream:true,
              metadata: { source:'llm-chat', conversationId: state.conversationId } }
          : { provider, baseUrl, apiKey, model, messages: msgs, temperature, max_tokens, stream:true }
      ),
      signal: state.controller.signal
    });
    if (!resp.ok) throw new Error(await resp.text() || 'HTTP error');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const pump = parseStream(
      (d)=> { placeholder.textContent += d; },
      ()=> { 
        state.messages.push({ role:'assistant', content: placeholder.textContent }); 
        updateMessageCount();
        // Display RAG sources if used
        if (ragResponse && ragResponse.sources) {
          displaySources(ragResponse.sources);
        }
        if (memorySnippets.length) {
         displayMemories(memorySnippets);
       }
        // Auto-save every 10 messages
        if (state.messages.length % 10 === 0) {
          saveConversation();
        }
      },
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

// Initialize on load
export function initialize() {
  initConversation();
  updateMessageCount();
  
  // Set up auto-save
  setInterval(() => {
    if (state.messages.length > 0 && state.ragEnabled) {
      saveConversation();
    }
  }, 60000); // Auto-save every minute
}