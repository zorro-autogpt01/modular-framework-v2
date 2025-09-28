const LEVELS = ['debug','info','warn','error'];
const envLevel = (typeof window !== 'undefined' && window.__LOG_LEVEL) || 'debug';
const current = LEVELS.indexOf(envLevel);
function ts(){return new Date().toISOString();}
export const Logger = {
  debug: (...args)=>{ if(LEVELS.indexOf('debug')>=current) console.debug(`[DBG ${ts()}]`,...args); },
  info:  (...args)=>{ if(LEVELS.indexOf('info') >=current) console.info (`[INF ${ts()}]`,...args); },
  warn:  (...args)=>{ if(LEVELS.indexOf('warn') >=current) console.warn (`[WRN ${ts()}]`,...args); },
  error: (...args)=>{ if(LEVELS.indexOf('error')>=current) console.error(`[ERR ${ts()}]`,...args); }
};
