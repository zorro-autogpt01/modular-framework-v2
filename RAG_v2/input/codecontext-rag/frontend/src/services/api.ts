import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import type {
  Repository,
  Feature,
  FeatureSuggestion,
  ConversationMessage,
  AgentAnalysis,
  FileRecommendation,
  ContextChunk,
  PatchValidation
} from '../types/index'

type ListRepositoriesResponse = Repository[]

type ListFeaturesResponse = {
  repo_id: string
  total_features: number
  features: Feature[]
}

type ListSuggestionsResponse = {
  repo_id: string
  total_suggestions: number
  suggestions: FeatureSuggestion[]
}

type ListAnalysesResponse = {
  repo_id: string
  total_analyses: number
  analyses: AgentAnalysis[]
}

type GetSuggestionDetailResponse = {
  suggestion: FeatureSuggestion
  conversation: ConversationMessage[]
}

type RecommendationsResponse = {
  session_id: string
  query: string
  recommendations: FileRecommendation[]
  summary?: { total_files: number; avg_confidence: number }
}

type DependenciesResponse =
  | {
      file_path: string
      graph_text: string
      format: 'mermaid' | 'plantuml'
      statistics: { total_dependencies: number; depth: number; circular_dependencies: any[] }
    }
  | {
      file_path: string
      graph: any
      statistics: { total_dependencies: number; depth: number; circular_dependencies: any[] }
    }

type GraphResponse =
  | { type: string; format: 'mermaid' | 'plantuml'; graph_text: string }
  | { type: string; graph: any }

type ContextResponse = {
  query: string
  chunks: ContextChunk[]
  summary?: { total_chunks: number; avg_confidence: number; retrieval_mode: string }
  artifacts?: any[]
}

type PromptResponse = {
  query: string
  model?: string
  messages: Array<{ role: string; content: string; meta?: any }>
  selected_chunks: Array<{
    id: string
    file_path: string
    start_line: number
    end_line: number
    language: string
    confidence: number
    reasons?: any[]
  }>
  token_usage: any
  summary?: any
  artifacts?: any[]
}

type PatchResponse = {
  model?: string
  messages_used: number
  patch?: string | null
  dry_run: boolean
  validation: PatchValidation
  summary?: any
}

type ApplyPatchResponse = {
  base_branch: string
  new_branch?: string
  commit?: string | null
  pushed: boolean
  pr_created: boolean
  pr?: any
  validation: any
  logs: string[]
  summary?: any
}

type ImpactAnalysisResponse = {
  modified_files: string[]
  impact: {
    risk_level: string
    affected_files: Array<{ file_path: string; impact_type: string; distance: number; confidence: number }>
    test_files: string[]
    recommendations: string[]
    statistics: { total_affected: number; direct_dependencies: number; transitive_dependencies: number }
  }
}

type SearchCodeResponse = {
  query: string
  results: Array<{
    file_path: string
    entity_type: string
    entity_name?: string
    similarity_score: number
    code_snippet: string
    line_number: number
  }>
  total_results: number
}

class ApiService {
  private client: AxiosInstance

  constructor() {
    // Default to nginx proxy path in production to avoid hardcoding host:port.
    const baseURL = import.meta.env.VITE_API_BASE || '/api'
    this.client = axios.create({
      baseURL,
      headers: { 'Content-Type': 'application/json' }
    })

    const apiKey = import.meta.env.VITE_API_KEY
    if (apiKey) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${apiKey}`
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { data?: any; params?: any } = {}
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url,
      params: options.params,
      data: options.data
    }
    const response = await this.client.request(config)
    const body = response.data

    if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
      return body.data as T
    }
    return body as T
  }

  async health(): Promise<any> {
    return this.request<any>('GET', '/health')
  }

  async listRepositories(params?: any): Promise<ListRepositoriesResponse> {
    return this.request<ListRepositoriesResponse>('GET', '/repositories', { params })
  }

  async addRepository(data: { connection_id: string; branch?: string; auto_index?: boolean }): Promise<Repository> {
    return this.request<Repository>('POST', '/repositories', { data })
  }

  async getRepository(id: string): Promise<Repository> {
    return this.request<Repository>('GET', `/repositories/${id}`)
  }

  async deleteRepository(id: string): Promise<{ message: string } | any> {
    return this.request('DELETE', `/repositories/${id}`)
  }

  async reindexRepository(id: string): Promise<{ message: string; job_id: string }> {
    return this.request('POST', `/repositories/${id}/reindex`)
  }

  async getIndexStatus(id: string): Promise<any> {
    return this.request('GET', `/repositories/${id}/index/status`)
  }

  async listFeatures(repoId: string, params?: any): Promise<ListFeaturesResponse> {
    return this.request<ListFeaturesResponse>('GET', `/features/${repoId}`, { params })
  }

  async listSuggestions(repoId: string, params?: any): Promise<ListSuggestionsResponse> {
    return this.request<ListSuggestionsResponse>('GET', `/features/${repoId}/suggestions`, { params })
  }

  async getSuggestionDetail(repoId: string, suggestionId: string): Promise<GetSuggestionDetailResponse> {
    return this.request<GetSuggestionDetailResponse>('GET', `/features/${repoId}/suggestions/${suggestionId}`)
  }

  async updateSuggestionStatus(repoId: string, suggestionId: string, status: string): Promise<{ status: string; updated: boolean }> {
    return this.request('POST', `/features/${repoId}/suggestions/${suggestionId}/status`, {
      params: { status }
    })
  }

  async listAnalyses(repoId: string, agentRole?: string): Promise<ListAnalysesResponse> {
    const params = agentRole ? { agent_role: agentRole } : undefined
    return this.request<ListAnalysesResponse>('GET', `/features/${repoId}/analyses`, { params })
  }

  async triggerProductAnalysis(repoId: string, skipFeatureExtraction = false): Promise<{ repo_id: string; status: string; message: string }> {
    return this.request('POST', `/features/${repoId}/analyze`, {
      data: { repo_id: repoId, skip_feature_extraction: skipFeatureExtraction }
    })
  }

  async getRecommendations(data: { repository_id: string; query: string; max_results?: number }): Promise<RecommendationsResponse> {
    return this.request<RecommendationsResponse>('POST', '/recommendations', { data })
  }

  async submitFeedback(sessionId: string, data: any): Promise<{ recorded: boolean; message: string }> {
    return this.request('POST', `/recommendations/${sessionId}/feedback`, { data })
  }

  async refineRecommendations(data: any): Promise<RecommendationsResponse> {
    return this.request<RecommendationsResponse>('POST', '/recommendations/refine', { data })
  }

  async searchCode(data: any): Promise<SearchCodeResponse> {
    return this.request<SearchCodeResponse>('POST', '/search/code', { data })
  }

  async getDependencies(filePath: string, repoId: string, depth = 2, format: 'json' | 'mermaid' | 'plantuml' = 'json'): Promise<DependenciesResponse> {
    const encoded = encodeURIComponent(filePath)
    return this.request<DependenciesResponse>('GET', `/dependencies/${encoded}`, {
      params: { repository_id: repoId, depth, direction: 'both', format }
    })
  }

  async getGraph(repoId: string, type: string, format: 'json' | 'mermaid' | 'plantuml' = 'json', nodeFilter = '', depth = 0): Promise<GraphResponse> {
    const params: any = { type, format }
    if (nodeFilter) params.node_filter = nodeFilter
    if (depth) params.depth = depth
    return this.request<GraphResponse>('GET', `/repositories/${repoId}/graphs`, { params })
  }

  async getContext(repoId: string, data: any): Promise<ContextResponse> {
    return this.request<ContextResponse>('POST', `/repositories/${repoId}/context`, { data })
  }

  async buildPrompt(repoId: string, data: any): Promise<PromptResponse> {
    return this.request<PromptResponse>('POST', `/repositories/${repoId}/prompt`, { data })
  }

  async generatePatch(repoId: string, data: any): Promise<PatchResponse> {
    return this.request<PatchResponse>('POST', `/repositories/${repoId}/patch`, { data })
  }

  async applyPatch(repoId: string, data: any): Promise<ApplyPatchResponse> {
    return this.request<ApplyPatchResponse>('POST', `/repositories/${repoId}/apply-patch`, { data })
  }

  async analyzeImpact(data: { repository_id: string; modified_files: string[]; analysis_depth?: number; options?: any }): Promise<ImpactAnalysisResponse> {
    return this.request<ImpactAnalysisResponse>('POST', '/impact-analysis', { data })
  }

  async selectTests(repoId: string, data: any): Promise<{ modified_files: string[]; ranked_tests: Array<{ test: string; score: number }> }> {
    return this.request('POST', `/repositories/${repoId}/tests/select`, { data })
  }

  async runTests(repoId: string, data: any): Promise<{ ok: boolean; output: string }> {
    return this.request('POST', `/repositories/${repoId}/tests/run`, { data })
  }
}

export const api = new ApiService()