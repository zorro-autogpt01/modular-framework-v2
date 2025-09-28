import { bus } from '../core/eventBus.js';
export function initModals(){
  bus.on('modal:open', ({ target })=> openModal(target));
  bus.on('modal:close', ({ target })=> closeModal(target));
}
function openModal(sel){ const m = document.querySelector(sel); if (m) m.classList.remove('hidden'); }
function closeModal(sel){ const m = document.querySelector(sel); if (m) m.classList.add('hidden'); }
