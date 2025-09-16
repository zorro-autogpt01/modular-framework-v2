import { initToolbar, applyProfileToFields, readOverrides } from './toolbar.js';
import { send, stop, clearChat } from './chat.js';
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
    // Settings tab: ensure config UI is wired and fresh
    initEmbeddedConfigOnce();
    refreshEmbeddedConfig();
    // default to Global sub-tab on first open
    showTab('global');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Init chat toolbar / composer
  initToolbar();
  document.getElementById('sendBtn')?.addEventListener('click', ()=> send(readOverrides));
  document.getElementById('stopBtn')?.addEventListener('click', stop);
  document.getElementById('clearBtn')?.addEventListener('click', clearChat);
  document.getElementById('resetBtn')?.addEventListener('click', applyProfileToFields);

  // Top-level tabs
  document.getElementById('tabBtnChat')?.addEventListener('click', ()=> activateMainTab('chat'));
  document.getElementById('tabBtnSettings')?.addEventListener('click', ()=> activateMainTab('settings'));

  // “Manage Profiles” in the chat toolbar just switches to Settings tab
  document.getElementById('manageBtn')?.addEventListener('click', ()=> activateMainTab('settings'));

  // Ready signal for host
  window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'llm-chat:module-ready', payload:{} }, '*');

  // Start on Chat
  activateMainTab('chat');
});
