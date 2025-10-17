import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { api } from '../services/api'
import { TrendingUp, FileCode, AlertCircle } from 'lucide-react'
import type { Repository, FileRecommendation } from '../types/index'

export const Recommendations: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [query, setQuery] = useState('implement user authentication with email and password')
  const [maxResults, setMaxResults] = useState(10)
  const [recommendations, setRecommendations] = useState<FileRecommendation[]>([])
  const [sessionId, setSessionId] = useState<string>('')
  const [summary, setSummary] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  React.useEffect(() => {
    loadRepos()
  }, [])

  const loadRepos = async () => {
    try {
      const data = await api.listRepositories()
      setRepos(data)
      if (data.length > 0) {
        setSelectedRepo(data[0].id)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load repositories')
    }
  }

  const getRecommendations = async () => {
    if (!selectedRepo || !query) return

    try {
      setLoading(true)
      setError('')
      const data = await api.getRecommendations({
        repository_id: selectedRepo,
        query,
        max_results: maxResults
      })
      setRecommendations(data.recommendations || [])
      setSessionId(data.session_id || '')
      setSummary(data.summary || null)
    } catch (err: any) {
      setError(err.message || 'Failed to get recommendations')
    } finally {
      setLoading(false)
    }
  }

  const getConfidenceVariant = (confidence: number) => {
    if (confidence >= 80) return 'success'
    if (confidence >= 60) return 'warning'
    return 'danger'
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      <Card title="Get File Recommendations">
        <div className="space-y-4">
          <div>
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Feature Description
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder="Describe the feature you want to implement..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Max Results
              </label>
              <input
                type="number"
                min="1"
                max="50"
                value={maxResults}
                onChange={(e) => setMaxResults(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="pt-7">
              <Button
                icon={<TrendingUp className="w-4 h-4" />}
                onClick={getRecommendations}
                loading={loading}
                disabled={!selectedRepo || !query}
              >
                Get Recommendations
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={getRecommendations} />}

      {loading ? (
        <LoadingSpinner text="Analyzing codebase..." />
      ) : recommendations.length > 0 ? (
        <>
          {/* Summary */}
          {summary && (
            <Card>
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-gray-600">Total Files</p>
                  <p className="text-2xl font-bold text-gray-900">{summary.total_files}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Avg Confidence</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Math.round(summary.avg_confidence)}%
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Session ID</p>
                  <p className="text-sm font-mono text-gray-600">{sessionId.slice(0, 8)}...</p>
                </div>
              </div>
            </Card>
          )}

          {/* Results */}
          <div className="space-y-4">
            {recommendations.map((rec, idx) => (
              <Card key={idx}>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileCode className="w-5 h-5 text-primary-600" />
                      <h3 className="font-semibold text-gray-900">{rec.file_path}</h3>
                    </div>
                    <Badge variant={getConfidenceVariant(rec.confidence)}>
                      {rec.confidence}% confidence
                    </Badge>
                  </div>

                  {rec.reasons && rec.reasons.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-gray-700">Why this file?</p>
                      {rec.reasons.map((reason, ridx) => (
                        <div key={ridx} className="flex items-start gap-2 text-sm">
                          <AlertCircle className="w-4 h-4 text-primary-600 mt-0.5 flex-shrink-0" />
                          <div className="flex-1">
                            <span className="font-medium">{reason.type}:</span>{' '}
                            <span className="text-gray-600">{reason.explanation}</span>
                            <span className="text-gray-500 ml-2">
                              (score: {reason.score.toFixed(2)})
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {rec.metadata && (
                    <div className="pt-3 border-t border-gray-200 text-sm text-gray-600">
                      <span>Language: {rec.metadata.language || 'unknown'}</span>
                      {rec.metadata.lines_of_code && (
                        <span className="ml-4">Lines: {rec.metadata.lines_of_code}</span>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}