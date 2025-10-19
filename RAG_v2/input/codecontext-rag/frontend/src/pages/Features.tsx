import React, { useEffect, useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { FeatureCard } from '../components/features/FeatureCard'
import { api } from '../services/api'
import { RefreshCw } from 'lucide-react'
import type { Feature, Repository } from '../types/index'

export const Features: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [minConfidence, setMinConfidence] = useState(0.5)

  useEffect(() => {
    loadRepos()
  }, [])

  useEffect(() => {
    if (selectedRepo) {
      loadFeatures()
    }
  }, [selectedRepo, categoryFilter, minConfidence])

  const loadRepos = async () => {
    try {
      const data = await api.listRepositories()
      setRepos(data)
      if (data.length > 0 && !selectedRepo) {
        setSelectedRepo(data[0].id)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load repositories')
    }
  }

  const loadFeatures = async () => {
    if (!selectedRepo) return

    try {
      setLoading(true)
      setError('')
      const data = await api.listFeatures(selectedRepo, {
        category: categoryFilter || undefined,
        min_confidence: minConfidence
      })
      setFeatures(data.features || [])
    } catch (err: any) {
      setError(err.message || 'Failed to load features')
    } finally {
      setLoading(false)
    }
  }

  const categories = Array.from(new Set(features.map(f => f.category)))

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Product Features</h2>
            <p className="mt-1 text-sm text-gray-600">
              Features automatically extracted from your codebase
            </p>
          </div>
          <Button icon={<RefreshCw className="w-4 h-4" />} onClick={loadFeatures}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Repository
            </label>
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Select repository...</option>
              {repos.map(repo => (
                <option key={repo.id} value={repo.id}>
                  {repo.full_name || repo.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Category
            </label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">All categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Min Confidence: {Math.round(minConfidence * 100)}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={loadFeatures} />}

      {loading ? (
        <LoadingSpinner text="Loading features..." />
      ) : features.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <p className="text-gray-600">No features found</p>
            <p className="text-sm text-gray-500 mt-2">
              Try selecting a different repository or adjusting filters
            </p>
          </div>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Found {features.length} features
            </p>
            <div className="flex items-center gap-2">
              {categories.map(cat => (
                <Badge key={cat}>{cat}</Badge>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map(feature => (
              <FeatureCard key={feature.id} feature={feature} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
