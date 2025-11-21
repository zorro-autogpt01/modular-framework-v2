import { LS, getProfiles, setProfiles, getActiveName, setActiveName, defaultProfiles } from './storage.js';
import { toast } from './ui.js';

const dom = {
  list: () => document.getElementById('profileList'),
  name: () => document.getElementById('pName'),
  provider: () => document.getElementById('pProvider'),
  model: () => document.getElementById('pModel'),
  baseUrl: () => document.getElementById('pBaseUrl'),
  apiKey: () => document.getElementById('pApiKey'),
  temp: () => document.getElementById('pTemp'),
  max: () => document.getElementById('pMax'),
  system: () => document.getElementById('pSystem'),
};

function collect(){
  return {
    name: dom.name().value.trim(),
    provider: dom.provider().value || undefined,
    baseUrl: dom.baseUrl().value.trim() || undefined,
    apiKey: dom.apiKey().value.trim() || undefined,
    model: dom.model().value.trim() || undefined,
    temperature: dom.temp().value ? Number(dom.temp().value) : undefined,
    max_tokens: dom.max().value ? Number(dom.max().value) : undefined,
    systemPrompt: dom.system().value || ''
  };
}

export function renderList(arr){
  const list = dom.list(); list.innerHTML = '';
  const active = getActiveName() || arr[0]?.name;
  arr.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div>
        <strong>${p.name}</strong>
        <span class="pill">${p.provider || '(inherit)'} · ${p.model || '(inherit)'} </span>
        <span class="muted">${p.baseUrl || '(inherit baseUrl)'}</span>
      </div>
      <button class="ghost">Edit</button>
      <button class="danger">Delete</button>`;
    const [_, editBtn, delBtn] = div.children;

    editBtn.onclick = () => edit(idx);
    delBtn.onclick = () => remove(idx);

    if (p.name === active) {
      const b = document.createElement('span');
      b.className = 'pill'; b.style.marginLeft='8px'; b.textContent = 'Active';
      div.firstElementChild.appendChild(b);
    } else {
      const setBtn = document.createElement('button');
      setBtn.className = 'ghost';
      setBtn.textContent = 'Set Active';
      setBtn.onclick = () => { setActiveName(p.name); renderList(JSON.parse(localStorage.getItem(LS.PROFILES))); };
      div.insertBefore(setBtn, editBtn);
    }
    list.appendChild(div);
  });
}

export function wireProfileForm(){
  document.getElementById('saveProfileBtn').addEventListener('click', addOrUpdateProfile);
  document.getElementById('loadDefaultsBtn').addEventListener('click', resetToDefaults);
  document.getElementById('exportBtn').addEventListener('click', exportProfiles);
  document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', onImportChange);
}

function addOrUpdateProfile(){
  const p = collect();
  if (!p.name) { toast('Name is required'); return; }
  const arr = getProfiles();
  const idx = arr.findIndex(x => x.name === p.name);
  if (idx >= 0) arr[idx] = p; else arr.push(p);
  setProfiles(arr);
  renderList(arr);
  toast('Profile saved.');
}

function edit(idx){
  const arr = getProfiles();
  const p = arr[idx]; if (!p) return;
  dom.name().value = p.name;
  dom.provider().value = p.provider || '';
  dom.model().value = p.model || '';
  dom.baseUrl().value = p.baseUrl || '';
  dom.apiKey().value = p.apiKey || '';
  dom.temp().value = p.temperature ?? '';
  dom.max().value = p.max_tokens ?? '';
  dom.system().value = p.systemPrompt || '';
}

function remove(idx){
  const arr = getProfiles();
  const [removed] = arr.splice(idx, 1);
  setProfiles(arr);
  const active = getActiveName();
  if (active === removed?.name) setActiveName(arr[0]?.name || '');
  renderList(arr);
}

function resetToDefaults(){
  if (!confirm('Replace all profiles with defaults?')) return;
  setProfiles(defaultProfiles);
  setActiveName(defaultProfiles[0].name);
  renderList(defaultProfiles);
}

function exportProfiles(){
  const arr = localStorage.getItem(LS.PROFILES) || '[]';
  const blob = new Blob([arr], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'llm_chat_profiles.json'; a.click();
  URL.revokeObjectURL(url);
}

function onImportChange(e){
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const arr = JSON.parse(reader.result);
      if(!Array.isArray(arr)) throw new Error('Invalid JSON');
      setProfiles(arr);
      renderList(arr);
    }catch(err){ toast('Import failed: ' + err.message); }
  };
  reader.readAsText(file);
}
