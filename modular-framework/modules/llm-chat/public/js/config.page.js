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
});
