class EventBus {
  constructor(){ this.map = new Map(); }
  on(ev, cb){ if(!this.map.has(ev)) this.map.set(ev, new Set()); this.map.get(ev).add(cb); return ()=>this.off(ev, cb); }
  once(ev, cb){ const off = this.on(ev,(...a)=>{ off(); cb(...a); }); return off; }
  off(ev, cb){ this.map.get(ev)?.delete(cb); }
  emit(ev, payload){ this.map.get(ev)?.forEach(fn=>{ try{ fn(payload);}catch(e){ console.error('Event handler error', ev, e);} }); }
}
export const bus = new EventBus();
