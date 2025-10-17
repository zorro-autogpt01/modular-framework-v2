import { useState, useEffect } from 'react'
import { api } from '../services/api'
import type { Repository } from '../types/index'

export const useRepositories = () => {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const loadRepositories = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await api.listRepositories()
      setRepositories(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load repositories')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRepositories()
  }, [])

  const addRepository = async (connectionId: string, branch?: string, autoIndex = true) => {
    try {
      await api.addRepository({
        connection_id: connectionId,
        branch,
        auto_index: autoIndex
      })
      await loadRepositories()
    } catch (err: any) {
      throw new Error(err.message || 'Failed to add repository')
    }
  }

  const deleteRepository = async (id: string) => {
    try {
      await api.deleteRepository(id)
      await loadRepositories()
    } catch (err: any) {
      throw new Error(err.message || 'Failed to delete repository')
    }
  }

  const reindexRepository = async (id: string) => {
    try {
      await api.reindexRepository(id)
      await loadRepositories()
    } catch (err: any) {
      throw new Error(err.message || 'Failed to reindex repository')
    }
  }

  return {
    repositories,
    loading,
    error,
    refresh: loadRepositories,
    addRepository,
    deleteRepository,
    reindexRepository
  }
}