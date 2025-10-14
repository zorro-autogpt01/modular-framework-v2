export type ApiEnvelope<T> = {
  success: boolean
  data: T
  error?: any
  metadata: { timestamp: string; request_id: string; version: string }
}

export type Repository = {
  id: string
  owner?: string
  name: string
  full_name?: string
  branch?: string
  status: string
  indexed_at?: string | null
  created_at?: string | null
}

