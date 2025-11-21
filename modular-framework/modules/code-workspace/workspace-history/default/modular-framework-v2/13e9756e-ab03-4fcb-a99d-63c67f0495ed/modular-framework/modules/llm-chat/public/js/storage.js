export const LS = {
  GLOBAL: 'llmChatConfig',
  PROFILES: 'llmChatProfiles',
  ACTIVE: 'llmChatActiveProfile',
};

export const defaultProfiles = [
  { name:'Frontend Engineer', provider:'openai', baseUrl:'https://api.openai.com', model:'gpt-4o-mini',
    systemPrompt:`You are a senior Frontend Engineer. Give precise, practical advice on HTML, CSS, JS, accessibility, and performance. Prefer code snippets and explain trade-offs briefly.` },
  { name:'React Specialist', provider:'openai', baseUrl:'https://api.openai.com', model:'gpt-4o-mini',
    systemPrompt:`You are a React expert. Use modern React (hooks, functional components), TypeScript-friendly patterns, and explain render/performance implications.` },
  { name:'Security Reviewer', provider:'openai-compatible', baseUrl:'https://api.together.xyz', model:'meta-llama/Meta-Llama-3-70B-Instruct-Turbo',
    systemPrompt:`Act as an application security reviewer. Identify vulnerabilities, threat models, and provide actionable remediations with clear risk levels.` },
  { name:'DevOps/SRE', provider:'ollama', baseUrl:'http://ollama:11434', model:'llama3',
    systemPrompt:`You are a pragmatic SRE. Provide concise, command-ready steps, incident runbooks, and rollback strategies.` },
  { name:'Data Scientist', provider:'openai-compatible', baseUrl:'https://api.openrouter.ai', model:'mistralai/mixtral-8x7b-instruct',
    systemPrompt:`You are a data scientist. Explain assumptions, feature engineering, eval metrics, and provide Python snippets when helpful.` },
  { name:'Socratic Tutor', provider:'openai', baseUrl:'https://api.openai.com', model:'gpt-4o-mini',
    systemPrompt:`Teach by asking guiding questions. Don’t give the answer outright; scaffold thinking and provide hints in steps.` },
  { name:'Unit Test Generator', provider:'openai', baseUrl:'https://api.openai.com', model:'gpt-4o-mini',
    systemPrompt:`Generate high-coverage unit tests with table-driven cases, edge conditions, and clear arrange/act/assert structure.` },
  { name:'Product Manager', provider:'openai', baseUrl:'https://api.openai.com', model:'gpt-4o-mini',
    systemPrompt:`Focus on user value, scope, acceptance criteria, and trade-offs. Produce crisp PRDs and success metrics.` }
];

export function getGlobal() {
  const raw = localStorage.getItem(LS.GLOBAL);
  const cfg = raw ? JSON.parse(raw) : {};
  return {
    provider: cfg.provider || 'openai',
    baseUrl:  cfg.baseUrl  || 'https://api.openai.com',
    apiKey:   cfg.apiKey   || '',
    model:    cfg.model    || 'gpt-4o-mini',
    temperature: Number(cfg.temperature ?? 0.7),
    max_tokens: cfg.max_tokens ? Number(cfg.max_tokens) : undefined
  };
}
export function setGlobal(cfg) { localStorage.setItem(LS.GLOBAL, JSON.stringify(cfg)); }

export function getProfiles() {
  const raw = localStorage.getItem(LS.PROFILES);
  const arr = raw ? JSON.parse(raw) : defaultProfiles;
  if (!raw) localStorage.setItem(LS.PROFILES, JSON.stringify(arr));
  return arr;
}
export function setProfiles(arr) { localStorage.setItem(LS.PROFILES, JSON.stringify(arr)); }

export function getActiveName() { return localStorage.getItem(LS.ACTIVE) || getProfiles()[0]?.name || ''; }
export function setActiveName(name) { localStorage.setItem(LS.ACTIVE, name || ''); }
