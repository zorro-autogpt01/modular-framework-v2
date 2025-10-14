const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'
const API_KEY = import.meta.env.VITE_API_KEY

async function req(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`
  const res = await fetch(`${BASE}${path}`, { ...opts, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

function normalizeReposResponse(raw: any): { repositories: any[] } {
  // Backend /repositories returns a plain array of RepositoryResponse
  // But support envelopes just in case
  if (Array.isArray(raw)) {
    return { repositories: raw }
  }
  if (raw?.data?.repositories && Array.isArray(raw.data.repositories)) {
    return { repositories: raw.data.repositories }
  }
  if (Array.isArray(raw?.data)) {
    return { repositories: raw.data }
  }
  if (Array.isArray(raw?.repositories)) {
    return { repositories: raw.repositories }
  }
  return { repositories: [] }
}

export const api = {
  health: () => req('/health'),

  listRepositories: async (params?: { status?: string; page?: number; per_page?: number }) => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', String(params.status))
    if (params?.page) q.set('page', String(params.page))
    if (params?.per_page) q.set('per_page', String(params.per_page))
    const qs = q.toString()
    const raw = await req(`/repositories${qs ? `?${qs}` : ''}`)
    return normalizeReposResponse(raw)
  },

  // Backend expects: { connection_id, branch?, auto_index? }
  addRepository: (body: { connection_id: string; branch?: string; auto_index?: boolean }) =>
    req('/repositories', { method: 'POST', body: JSON.stringify(body) }),

  getRepository: (id: string) => req(`/repositories/${id}`),

  deleteRepository: (id: string) => req(`/repositories/${id}`, { method: 'DELETE' }),

  // Backend uses /{repo_id}/reindex instead of /index
  reindexRepository: (id: string) => req(`/repositories/${id}/reindex`, { method: 'POST' }),

  indexStatus: (id: string) => req(`/repositories/${id}/index/status`),

  recommendations: (body: any) => req('/recommendations', { method: 'POST', body: JSON.stringify(body) }),

  feedback: (sessionId: string, body: any) => req(`/recommendations/${sessionId}/feedback`, { method: 'POST', body: JSON.stringify(body) }),

  refine: (body: any) => req('/recommendations/refine', { method: 'POST', body: JSON.stringify(body) }),

  dependencies: (filePath: string, repoId: string, depth = 2, direction = 'both', format = 'json') => {
    const enc = encodeURIComponent(filePath)
    const q = new URLSearchParams({ repository_id: repoId, depth: String(depth), direction, format })
    return req(`/dependencies/${enc}?${q.toString()}`)
  },

  impact: (body: any) => req('/impact-analysis', { method: 'POST', body: JSON.stringify(body) }),

  searchCode: (body: any) => req('/search/code', { method: 'POST', body: JSON.stringify(body) })
}