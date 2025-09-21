import { initToolbar, applyProfileToFields, readOverrides } from './toolbar.js';
import { send, stop, clearChat, summarizeConversation, initialize, startNewConversation, saveConversation, searchPastConversations } from './chat.js';
import { showTab } from './ui.js';
import { initEmbeddedConfigOnce, refreshEmbeddedConfig } from './config.embed.js';

function activateMainTab(name){
  const chat = document.getElementById('tab-chat');
  const settings = document.getElementById('tab-settings');
  const bChat = document.getElementById('tabBtnChat');
  const bSettings = document.getElementById('tabBtnSettings');

  const isChat = (name === 'chat');
  chat.style.display = isChat ? '' : 'none';
  settings.style.display = isChat ? 'none' : '';

  bChat.classList.toggle('active', isChat);
  bSettings.classList.toggle('active', !isChat);

  if (!isChat) {
    initEmbeddedConfigOnce();
    refreshEmbeddedConfig();
    showTab('global');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize chat system
  initialize();

  initToolbar();
  
  // Existing buttons
  document.getElementById('sendBtn')?.addEventListener('click', ()=> send(readOverrides));
  document.getElementById('stopBtn')?.addEventListener('click', stop);
  document.getElementById('clearBtn')?.addEventListener('click', clearChat);
  document.getElementById('resetBtn')?.addEventListener('click', applyProfileToFields);

  // Tab navigation
  document.getElementById('tabBtnChat')?.addEventListener('click', ()=> activateMainTab('chat'));
  document.getElementById('tabBtnSettings')?.addEventListener('click', ()=> activateMainTab('settings'));
  document.getElementById('manageBtn')?.addEventListener('click', ()=> activateMainTab('settings'));

  // New conversation management buttons
  document.getElementById('newConvBtn')?.addEventListener('click', startNewConversation);
  document.getElementById('saveConvBtn')?.addEventListener('click', saveConversation);
  document.getElementById('searchConvBtn')?.addEventListener('click', searchPastConversations);
  document.getElementById('summarizeBtn')?.addEventListener('click', summarizeConversation);

  // RAG controls
  document.getElementById('ingestBtn')?.addEventListener('click', () => {
    window.open('/rag/docs', '_blank');
  });
  
  document.getElementById('statsBtn')?.addEventListener('click', async () => {
    try {
      const response = await fetch('/rag/stats');
      const stats = await response.json();
      alert(`RAG Statistics:\n\nCode chunks: ${stats.code_chunks}\nDocument chunks: ${stats.documents_chunks ?? stats.document_chunks}\nTotal: ${stats.total_chunks}`);
    } catch (error) {
      alert('RAG service not available');
    }
  });

  // Test RAG connection
  document.getElementById('testRagBtn')?.addEventListener('click', async () => {
    const url = document.getElementById('ragServiceUrl')?.value || '/rag';
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        alert('✅ RAG service is connected and healthy!');
      } else {
        alert('❌ RAG service responded but may have issues');
      }
    } catch (error) {
      alert('❌ Cannot connect to RAG service. Make sure it\'s running.');
    }
  });

  // Save RAG URL to localStorage when changed
  document.getElementById('ragServiceUrl')?.addEventListener('change', (e) => {
    window.RAG_SERVICE_URL = e.target.value;
    localStorage.setItem('ragServiceUrl', e.target.value);
  });

  // Load saved RAG URL
  const savedRagUrl = localStorage.getItem('ragServiceUrl');
  if (savedRagUrl) {
    window.RAG_SERVICE_URL = savedRagUrl;
    const ragUrlInput = document.getElementById('ragServiceUrl');
    if (ragUrlInput) ragUrlInput.value = savedRagUrl;
  }

  // --- LLM Gateway URL persistence and health test ---
  document.getElementById('llmGatewayUrl')?.addEventListener('change', (e) => {
    const v = (e.target.value || '').trim();
    localStorage.setItem('llmGatewayUrl', v);
    window.LLM_GATEWAY_URL = v;
  });
  document.getElementById('testGatewayBtn')?.addEventListener('click', async () => {
  const url = (document.getElementById('llmGatewayUrl')?.value || '').trim().replace(/\/+$/, '');
  if (!url) return alert('Enter gateway URL first');
  try {
    const res = await fetch(`${url}/health`);
    alert(res.ok ? '✅ Gateway is healthy' : '❌ Gateway responded with error');
  } catch {
    alert('❌ Cannot reach gateway');
  }
});
  // Load saved Gateway URL
  const savedGw = localStorage.getItem('llmGatewayUrl');
  if (savedGw) {
    window.LLM_GATEWAY_URL = savedGw;
    const gwInput = document.getElementById('llmGatewayUrl');
    if (gwInput) gwInput.value = savedGw;
  }

  // Handle Enter key in chat input
  document.getElementById('input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(readOverrides);
    }
  });

  window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'llm-chat:module-ready', payload:{} }, '*');

  activateMainTab('chat');
});