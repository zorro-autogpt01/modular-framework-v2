import { qs, qsa } from './dom.js';
import { bus } from '../core/eventBus.js';

export function initPanels(){
  // Sidebar tabs
  qsa('.sidebar-tab').forEach(tab=>{
    tab.addEventListener('click', ()=> switchSidebarPanel(tab.dataset.panel));
  });

  // Bottom tabs
  qsa('.bottom-tab').forEach(tab=>{
    tab.addEventListener('click', ()=> switchBottomPanel(tab.dataset.panel));
  });

  // Collapsible repo sections
  qsa('[data-toggle-section]').forEach(header => {
    header.addEventListener('click', ()=> toggleRepoSection(header.getAttribute('data-toggle-section')));
  });

  // Events
  bus.on('panel:show', ({ name }) => switchBottomPanel(name));
}

export function switchSidebarPanel(panel){
  qsa('.sidebar-tab').forEach(t=>t.classList.remove('active'));
  qsa('.sidebar-panel').forEach(p=>p.classList.add('hidden'));
  qs(`[data-panel="${panel}"]`)?.classList.add('active');
  qs(`#${panel}-panel`)?.classList.remove('hidden');
}

export function switchBottomPanel(panel){
  qsa('.bottom-tab').forEach(t=>t.classList.remove('active'));
  qsa('.bottom-content-panel').forEach(p=>p.classList.add('hidden'));
  qs(`[data-panel="${panel}"]`)?.classList.add('active');
  qs(`#${panel}-panel`)?.classList.remove('hidden');
}

export function updateWorkspaceIndicator(text){
  const el = qs('#workspaceIndicator'); if (el) el.textContent = text;
}

export function updateConnectionStatus(connected, host=''){
  const indicator = qs('#connectionStatus');
  const text = qs('#connectionText');
  const info = qs('#connectionInfo');
  if (!indicator || !text || !info) return;
  if (connected){
    indicator.classList.add('connected');
    text.textContent = `Connected to ${host}`;
    info.textContent = `🔗 ${host}`;
  } else {
    indicator.classList.remove('connected');
    text.textContent = 'Disconnected';
    info.textContent = '🔗 Local';
  }
}

export function toggleRepoSection(name){
  const content = qs(`#${name}Section`);
  const toggle = qs(`#${name}Toggle`);
  if (!content || !toggle) return;
  content.classList.toggle('collapsed');
  toggle.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
}
