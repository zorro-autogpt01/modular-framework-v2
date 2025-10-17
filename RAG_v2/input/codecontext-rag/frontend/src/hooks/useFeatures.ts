import { useState, useEffect } from 'react'
import { api } from '../services/api'
import type { Feature, FeatureSuggestion } from '../types/index'

export const useFeatures = (repoId: string | null) => {
  const [features, setFeatures] = useState<Feature[]>([])
  const [suggestions, setSuggestions] = useState<FeatureSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const loadFeatures = async () => {
    if (!repoId) return

    try {
      setLoading(true)
      setError('')
      const data = await api.listFeatures(repoId)
      setFeatures(data.features || [])
    } catch (err: any) {
      setError(err.message || 'Failed to load features')
    } finally {
      setLoading(false)
    }
  }

  const loadSuggestions = async () => {
    if (!repoId) return

    try {
      const data = await api.listSuggestions(repoId)
      setSuggestions(data.suggestions || [])
    } catch (err: any) {
      console.error('Failed to load suggestions:', err)
    }
  }

  useEffect(() => {
    if (repoId) {
      loadFeatures()
      loadSuggestions()
    }
  }, [repoId])

  const triggerAnalysis = async (skipFeatureExtraction = false) => {
    if (!repoId) return

    try {
      setLoading(true)
      setError('')
      await api.triggerProductAnalysis(repoId, skipFeatureExtraction)
      // Poll for updates after a delay
      setTimeout(() => {
        loadFeatures()
        loadSuggestions()
      }, 5000)
    } catch (err: any) {
      setError(err.message || 'Failed to trigger analysis')
    } finally {
      setLoading(false)
    }
  }

  const updateSuggestionStatus = async (suggestionId: string, status: string) => {
    if (!repoId) return

    try {
      await api.updateSuggestionStatus(repoId, suggestionId, status)
      await loadSuggestions()
    } catch (err: any) {
      throw new Error(err.message || 'Failed to update suggestion')
    }
  }

  return {
    features,
    suggestions,
    loading,
    error,
    refresh: loadFeatures,
    triggerAnalysis,
    updateSuggestionStatus
  }
}