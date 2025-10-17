// Repository types
export interface Repository {
  id: string
  owner: string
  name: string
  full_name: string
  branch: string
  status: 'pending' | 'indexing' | 'indexed' | 'error'
  indexed_at?: string
  created_at?: string
  statistics?: {
    total_files: number
    indexed_files: number
  }
}

// Feature types
export interface Feature {
  id: string
  repo_id: string
  name: string
  description: string
  category: string
  code_files: string[]
  api_endpoints: string[]
  ui_components: string[]
  maturity: string
  confidence: number
  created_at: string
}

export interface FeatureSuggestion {
  id: string
  repo_id: string
  title: string
  description: string
  rationale: string
  market_evidence: any
  priority: 'critical' | 'high' | 'medium' | 'low'
  effort_estimate: 'small' | 'medium' | 'large' | 'xl'
  dependencies: string[]
  status: 'proposed' | 'approved' | 'in_progress' | 'completed' | 'rejected'
  proposed_by: string
  created_at: string
}

export interface ConversationMessage {
  id: string
  agent_role: string
  message: string
  reasoning: string
  created_at: string
}

export interface AgentAnalysis {
  id: string
  agent_role: string
  analysis_type: string
  summary: string
  details: any
  created_at: string
}

// Recommendation types
export interface FileRecommendation {
  file_path: string
  confidence: number
  reasons: Reason[]
  metadata?: any
}

export interface Reason {
  type: string
  score: number
  explanation: string
}

// Context types
export interface ContextChunk {
  file_path: string
  start_line: number
  end_line: number
  language: string
  snippet: string
  confidence: number
  reasons: Reason[]
  distance?: number
}

// Graph types
export interface GraphNode {
  id: string
  label: string
  type: string
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  weight?: number
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// Patch types
export interface PatchValidation {
  ok: boolean
  issues: string[]
  files: string[]
}

export interface Patch {
  model?: string
  messages_used: number
  patch: string
  validation: PatchValidation
  dry_run: boolean
}

// API Response wrapper
export interface ApiResponse<T> {
  success: boolean
  data: T
  error?: any
  metadata: {
    timestamp: string
    request_id: string
    version: string
  }
}