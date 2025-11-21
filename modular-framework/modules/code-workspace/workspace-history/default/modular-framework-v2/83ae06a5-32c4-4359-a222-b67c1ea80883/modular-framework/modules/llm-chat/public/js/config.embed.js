import { getGlobal, setGlobal, getProfiles, setProfiles, setActiveName, defaultProfiles } from './storage.js';
import { showTab, toast } from './ui.js';
import { renderList, wireProfileForm } from './profiles.js';

function loadGlobalIntoForm(){
  const c = getGlobal();
  const $ = (id)=>document.getElementById(id);
  $('provider').value = c.provider;
  $('baseUrl').value  = c.baseUrl;
  $('apiKey').value   = c.apiKey;
  $('model').value    = c.model;
  $('temperature').value = c.temperature ?? 0.7;
  $('max_tokens').value  = c.max_tokens ?? '';
}

function saveGlobalFromForm(){
  const $ = (id)=>document.getElementById(id);
  setGlobal({
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: Number($('temperature').value),
    max_tokens: $('max_tokens').value ? Number($('max_tokens').value) : undefined
  });
  toast('Global settings saved.');
}

let wired = false;
export function initEmbeddedConfigOnce(){
  if (wired) return;

  // Seed defaults if missing
  if ((getProfiles() || []).length === 0) {
    setProfiles(defaultProfiles);
    setActiveName(defaultProfiles[0]?.name || '');
  }

  // sub-tabs
  document.getElementById('tGlobal')?.addEventListener('click', ()=>showTab('global'));
  document.getElementById('tProfiles')?.addEventListener('click', ()=>showTab('profiles'));

  // global form
  document.getElementById('saveGlobalBtn')?.addEventListener('click', saveGlobalFromForm);

  // render UI immediately
  loadGlobalIntoForm();
  renderList(getProfiles());
  wireProfileForm();

  wired = true;
}

export function refreshEmbeddedConfig(){
  loadGlobalIntoForm();
  renderList(getProfiles());
  if (!localStorage.getItem('llmChatActiveProfile')) {
    setActiveName(defaultProfiles[0]?.name || '');
  }
}
