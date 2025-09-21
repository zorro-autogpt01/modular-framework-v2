import { getGlobal, setGlobal, getProfiles, setProfiles, setActiveName, defaultProfiles } from './storage.js';
import { showTab, toast } from './ui.js';
import { renderList, wireProfileForm } from './profiles.js';

function loadGlobalIntoForm(){
  const c = getGlobal();
  provider.value = c.provider;
  baseUrl.value  = c.baseUrl;
  apiKey.value   = c.apiKey;
  model.value    = c.model;
  temperature.value = c.temperature ?? 0.7;
  max_tokens.value  = c.max_tokens ?? '';
}

function saveGlobalFromForm(){
  setGlobal({
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    temperature: Number(temperature.value),
    max_tokens: max_tokens.value ? Number(max_tokens.value) : undefined
  });
  toast('Global settings saved.');
}

document.addEventListener('DOMContentLoaded', () => {
  // tabs
  document.getElementById('tGlobal').addEventListener('click', ()=>showTab('global'));
  document.getElementById('tProfiles').addEventListener('click', ()=>showTab('profiles'));

  // global form
  document.getElementById('saveGlobalBtn').addEventListener('click', saveGlobalFromForm);
  loadGlobalIntoForm();

  // profiles
  const arr = getProfiles();
  renderList(arr);
  wireProfileForm();

  if (!localStorage.getItem('llmChatActiveProfile')) {
    setActiveName(defaultProfiles[0]?.name || '');
  }

  // --- LLM Gateway URL persistence and health test (standalone config page) ---
  document.getElementById('llmGatewayUrl')?.addEventListener('change', (e) => {
    const v = (e.target.value || '').trim();
    localStorage.setItem('llmGatewayUrl', v);
    window.LLM_GATEWAY_URL = v;
  });
  document.getElementById('testGatewayBtn')?.addEventListener('click', async () => {
    const url = (document.getElementById('llmGatewayUrl')?.value || '').replace(/\/$/, '');
    if (!url) return alert('Enter gateway URL first');
    try {
      const res = await fetch(`${url}/health`);
      alert(res.ok ? '✅ Gateway is healthy' : '❌ Gateway responded with error');
    } catch {
      alert('❌ Cannot reach gateway');
    }
  });
  const savedGw = localStorage.getItem('llmGatewayUrl');
  if (savedGw) {
    window.LLM_GATEWAY_URL = savedGw;
    const gwInput = document.getElementById('llmGatewayUrl');
    if (gwInput) gwInput.value = savedGw;
  }

});
