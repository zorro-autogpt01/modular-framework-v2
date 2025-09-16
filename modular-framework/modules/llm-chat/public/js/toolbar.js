import { getGlobal, getProfiles, getActiveName, setActiveName, LS } from './storage.js';
import { getEl } from './ui.js';

export function initToolbar() {
  const sel = getEl('profileSelect');
  const profiles = getProfiles();
  sel.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.name; opt.textContent = p.name; sel.appendChild(opt);
  }
  const activeName = getActiveName();
  if (activeName) sel.value = activeName;

  applyProfileToFields();

  sel.addEventListener('change', () => {
    setActiveName(sel.value);
    applyProfileToFields();
  });

  getEl('resetBtn').addEventListener('click', applyProfileToFields);

  window.addEventListener('storage', (e) => {
    if (e.key === LS.PROFILES || e.key === LS.ACTIVE) initToolbar();
  });
}

export function applyProfileToFields() {
  const g = getGlobal();
  const p = getProfiles().find(x => x.name === getActiveName()) || {};
  getEl('providerSelect').value = p.provider ?? g.provider;
  getEl('modelInput').value     = p.model    ?? g.model;
  getEl('baseUrlInput').value   = p.baseUrl  ?? g.baseUrl;
  getEl('tempInput').value      = p.temperature ?? g.temperature ?? 0.7;
  getEl('maxTokInput').value    = p.max_tokens ?? g.max_tokens ?? '';
  getEl('sysInput').value       = p.systemPrompt || '';
}

export function readOverrides() {
  return {
    provider:    getEl('providerSelect').value.trim() || undefined,
    baseUrl:     getEl('baseUrlInput').value.trim()   || undefined,
    model:       getEl('modelInput').value.trim()     || undefined,
    temperature: getEl('tempInput').value !== '' ? Number(getEl('tempInput').value) : undefined,
    max_tokens:  getEl('maxTokInput').value !== '' ? Number(getEl('maxTokInput').value) : undefined,
    system:      getEl('sysInput').value || ''
  };
}
