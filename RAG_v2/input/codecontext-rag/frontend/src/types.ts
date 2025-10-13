export type ApiEnvelope<T> = {
  success: boolean
  data: T
  error?: any
  metadata: { timestamp: string; request_id: string; version: string }
}

export type Repository = {
  id: string
  name: string
  source_type: string
  status: string
  created_at: string
  last_indexed_at?: string | null
}
