import { z } from 'zod';

const API_BASE_URL = import.meta.env.VITE_API_URL || (window as any).REACT_APP_API_URL || 'http://localhost:3020';
const GATEWAY_BASE_URL = import.meta.env.VITE_GATEWAY_URL || (window as any).REACT_APP_GATEWAY_URL || 'http://localhost:3010';
const LOG = String(import.meta.env.VITE_LOG_API_CALLS) === 'true';

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchWithRetry(path: string, options: RequestInit = {}, maxRetries = 3, base: 'api' | 'gateway' = 'api') {
  const baseUrl = base === 'api' ? API_BASE_URL : GATEWAY_BASE_URL;
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers||{}) }, ...options });
      if (LOG) console.debug(`[API] ${options.method||'GET'} ${url} -> ${res.status}`);
      if (res.ok) return res;
      if (res.status >= 500 && i < maxRetries - 1) {
        await delay(1000 * (i + 1));
        continue;
      }
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await delay(1000 * (i + 1));
    }
  }
  throw new Error('Unreachable');
}

export const api = {
  // Conversations
  getConversationFull: (id: string) => fetchWithRetry(`/api/conversations/${id}/full`),
  createConversation: (payload: { id: string; title: string }) => fetchWithRetry('/api/conversations', { method: 'POST', body: JSON.stringify(payload) }, 3, 'gateway'),

  // Branches
  listBranches: (conversationId: string) => fetchWithRetry(`/api/conversations/${conversationId}/branches`),
  getBranchMessages: (branchId: string, query?: { limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (query?.limit) q.set('limit', String(query.limit));
    if (query?.before) q.set('before', query.before);
    return fetchWithRetry(`/api/branches/${branchId}/messages${q.size ? `?${q}`:''}`);
  },
  createBranch: (payload: any) => fetchWithRetry('/api/branches', { method: 'POST', body: JSON.stringify(payload) }),
  updateBranch: (id: string, payload: any) => fetchWithRetry(`/api/branches/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  activateBranch: (id: string) => fetchWithRetry(`/api/branches/${id}/activate`, { method: 'PUT' }),
  deleteBranch: (id: string) => fetchWithRetry(`/api/branches/${id}`, { method: 'DELETE' }),

  // Goals
  getGoal: (conversationId: string) => fetchWithRetry(`/api/conversations/${conversationId}/goal`),
  createGoal: (conversationId: string, payload: any) => fetchWithRetry(`/api/conversations/${conversationId}/goal`, { method: 'POST', body: JSON.stringify(payload) }),
  updateGoal: (id: string, payload: any) => fetchWithRetry(`/api/goals/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),

  // Messages
  updateMessageMeta: (id: string, payload: any) => fetchWithRetry(`/api/messages/${id}/metadata`, { method: 'PUT', body: JSON.stringify(payload) }),

  // Personalities
  listPersonalities: () => fetchWithRetry('/api/personalities'),
  getPersonality: (id: string) => fetchWithRetry(`/api/personalities/${id}`),

  // Schemas
  listSchemas: (query?: { category?: string; tags?: string }) => {
    const q = new URLSearchParams();
    if (query?.category) q.set('category', query.category);
    if (query?.tags) q.set('tags', query.tags);
    return fetchWithRetry(`/api/schemas${q.size ? `?${q}`:''}`);
  },
  getSchema: (id: string | number) => fetchWithRetry(`/api/schemas/${id}`),
  createSchema: (payload: any) => fetchWithRetry('/api/schemas', { method: 'POST', body: JSON.stringify(payload) }),
  generateSchema: (payload: any) => fetchWithRetry('/api/schemas/generate', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSchema: (id: string | number) => fetchWithRetry(`/api/schemas/${id}`, { method: 'DELETE' }),

  // Actions
  listActions: (category?: string) => fetchWithRetry(`/api/actions${category ? `?category=${encodeURIComponent(category)}`:''}`),
  trackActionUse: (id: string) => fetchWithRetry(`/api/actions/${id}/use`, { method: 'POST' }),

  // Advisor
  suggest: (payload: any) => fetchWithRetry('/api/advisor/suggest', { method: 'POST', body: JSON.stringify(payload) }),

  // Context
  optimizeContext: (payload: any) => fetchWithRetry('/api/context/optimize', { method: 'POST', body: JSON.stringify(payload) }),

  // Models (gateway)
  listModels: () => fetchWithRetry('/api/models', {}, 3, 'gateway'),

  // Chat
  chat: (payload: any) => fetchWithRetry('/api/chat', { method: 'POST', body: JSON.stringify(payload) })
};

export { API_BASE_URL, GATEWAY_BASE_URL };
