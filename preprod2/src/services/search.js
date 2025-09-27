import { qs } from '../ui/dom.js';
import { bus } from '../core/eventBus.js';

export function searchInFiles(query){
  const results = qs('#searchResults'); if (!results) return;
  if (!query){ results.innerHTML=''; return; }
  results.innerHTML = `<div class="pad-8 muted">Searching for \"${query.replaceAll('"','&quot;')}\"...</div>`;
  setTimeout(()=>{
    results.innerHTML = `<div class="pad-8" style="cursor:pointer;font-size:11px;" data-open="README.md"><div style="font-weight:bold;">README.md:5</div><div class="muted">Advanced Web IDE Pro</div></div>`;
    results.querySelector('[data-open]')?.addEventListener('click', (e)=>{
      const path = e.currentTarget.getAttribute('data-open');
      bus.emit('file:open', { path });
    });
  }, 300);
}
