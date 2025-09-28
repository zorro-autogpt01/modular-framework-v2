import { qs } from './dom.js';
export function setStatus(message){
  const el = qs('#statusMessage'); if (!el) return;
  el.textContent = message;
  setTimeout(()=>{ el.textContent = 'Ready'; }, 3000);
}
