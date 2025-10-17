import axios, { AxiosInstance } from 'axios'
import type { ApiResponse } from '../types/index'

class ApiService {
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:8000',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    // Add API key if configured
    const apiKey = import.meta.env.VITE_API_KEY
    if (apiKey) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${apiKey}`
    }
  }

  // Generic request handler
  private async request<T>(method: string, url: string, data?: any): Promise<T> {
    const response = await this.client.request<ApiResponse<T>>({
      method,
      url,
      data
    })
    return response.data.data
  }

  // Health
  async health() {
    return this.request('GET', '/health')
  }

  // Repositories
  async listRepositories(params?: any) {
    return this.request('GET', '/repositories', params)
  }

  async addRepository(data: any) {
    return this.request('POST', '/repositories', data)
  }

  async getRepository(id: string) {
    return this.request('GET', `/repositories/${id}`)
  }

  async deleteRepository(id: string) {
    return this.request('DELETE', `/repositories/${id}`)
  }

  async reindexRepository(id: string) {
    return this.request('POST', `/repositories/${id}/reindex`)
  }

  async getIndexStatus(id: string) {
    return this.request('GET', `/repositories/${id}/index/status`)
  }

  // Features
  async listFeatures(repoId: string, params?: any) {
    return this.request('GET', `/features/${repoId}`, params)
  }

  async listSuggestions(repoId: string, params?: any) {
    return this.request('GET', `/features/${repoId}/suggestions`, params)
  }

  async getSuggestionDetail(repoId: string, suggestionId: string) {
    return this.request('GET', `/features/${repoId}/suggestions/${suggestionId}`)
  }

  async updateSuggestionStatus(repoId: string, suggestionId: string, status: string) {
    return this.request('POST', `/features/${repoId}/suggestions/${suggestionId}/status?status=${status}`)
  }

  async listAnalyses(repoId: string, agentRole?: string) {
    const url = agentRole 
      ? `/features/${repoId}/analyses?agent_role=${agentRole}`
      : `/features/${repoId}/analyses`
    return this.request('GET', url)
  }

  async triggerProductAnalysis(repoId: string, skipFeatureExtraction = false) {
    return this.request('POST', `/features/${repoId}/analyze`, {
      repo_id: repoId,
      skip_feature_extraction: skipFeatureExtraction
    })
  }

  // Recommendations
  async getRecommendations(data: any) {
    return this.request('POST', '/recommendations', data)
  }

  async submitFeedback(sessionId: string, data: any) {
    return this.request('POST', `/recommendations/${sessionId}/feedback`, data)
  }

  async refineRecommendations(data: any) {
    return this.request('POST', '/recommendations/refine', data)
  }

  // Search
  async searchCode(data: any) {
    return this.request('POST', '/search/code', data)
  }

  // Dependencies
  async getDependencies(filePath: string, repoId: string, depth = 2, format = 'json') {
    const encoded = encodeURIComponent(filePath)
    return this.request('GET', `/dependencies/${encoded}?repository_id=${repoId}&depth=${depth}&direction=both&format=${format}`)
  }

  // Graphs
  async getGraph(repoId: string, type: string, format = 'json', nodeFilter = '', depth = 0) {
    let url = `/repositories/${repoId}/graphs?type=${type}&format=${format}`
    if (nodeFilter) url += `&node_filter=${encodeURIComponent(nodeFilter)}`
    if (depth) url += `&depth=${depth}`
    return this.request('GET', url)
  }

  // Context
  async getContext(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/context`, data)
  }

  // Prompts
  async buildPrompt(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/prompt`, data)
  }

  // Patches
  async generatePatch(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/patch`, data)
  }

  async applyPatch(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/apply-patch`, data)
  }

  // Impact Analysis
  async analyzeImpact(data: any) {
    return this.request('POST', '/impact-analysis', data)
  }

  // Tests
  async selectTests(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/tests/select`, data)
  }

  async runTests(repoId: string, data: any) {
    return this.request('POST', `/repositories/${repoId}/tests/run`, data)
  }
}

export const api = new ApiService()