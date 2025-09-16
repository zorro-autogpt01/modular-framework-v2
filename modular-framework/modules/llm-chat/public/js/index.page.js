import { initToolbar, applyProfileToFields, readOverrides } from './toolbar.js';
import { send, stop, clearChat } from './chat.js';

window.openConfig = ()=> {
  window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'llm-chat:open-config', payload:{} }, '*');
  window.open('./config','_blank');
};

document.addEventListener('DOMContentLoaded', () => {
  initToolbar();
  document.getElementById('sendBtn').addEventListener('click', ()=> send(readOverrides));
  document.getElementById('stopBtn').addEventListener('click', stop);
  document.getElementById('clearBtn').addEventListener('click', clearChat);
  document.getElementById('resetBtn').addEventListener('click', applyProfileToFields);

  window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'llm-chat:module-ready', payload:{} }, '*');
});
