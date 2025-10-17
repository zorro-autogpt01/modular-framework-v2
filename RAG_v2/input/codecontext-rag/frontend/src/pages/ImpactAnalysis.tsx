import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { api } from '../services/api'
import { Activity, AlertTriangle } from 'lucide-react'
import type { Repository } from '../types/index'

export const ImpactAnalysis: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [filesText, setFilesText] = useState('src/auth/login.py\nsrc/models/user.py')
  const [impact, setImpact] = useState<any>(null)
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

  const analyze = async () => {
    if (!selectedRepo || !filesText) return

    const files = filesText.split('\n').map(f => f.trim()).filter(Boolean)

    try {
      setLoading(true)
      setError('')
      const data = await api.analyzeImpact({
        repository_id: selectedRepo,
        modified_files: files,
        analysis_depth: 2
      })
      setImpact(data.impact || null)
    } catch (err: any) {
      setError(err.message || 'Failed to analyze impact')
    } finally {
      setLoading(false)
    }
  }

  const getRiskBadge = (risk: string) => {
    switch (risk) {
      case 'high':
        return <Badge variant="danger">High Risk</Badge>
      case 'medium':
        return <Badge variant="warning">Medium Risk</Badge>
      case 'low':
        return <Badge variant="success">Low Risk</Badge>
      default:
        return <Badge>Unknown</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Impact Analysis">
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
              Modified Files (one per line)
            </label>
            <textarea
              value={filesText}
              onChange={(e) => setFilesText(e.target.value)}
              rows={6}
              placeholder="src/auth/login.py&#10;src/models/user.py"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 font-mono text-sm"
            />
          </div>

          <Button
            icon={<Activity className="w-4 h-4" />}
            onClick={analyze}
            loading={loading}
            disabled={!selectedRepo || !filesText}
          >
            Analyze Impact
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={analyze} />}

      {loading ? (
        <LoadingSpinner text="Analyzing impact..." />
      ) : impact ? (
        <>
          <Card>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-6 h-6 text-yellow-600" />
                <h3 className="text-lg font-semibold text-gray-900">Risk Assessment</h3>
              </div>
              {getRiskBadge(impact.risk_level)}
            </div>

            {impact.statistics && (
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-gray-600">Total Affected</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {impact.statistics.total_affected}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Direct Dependencies</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {impact.statistics.direct_dependencies}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Transitive</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {impact.statistics.transitive_dependencies}
                  </p>
                </div>
              </div>
            )}
          </Card>

          {impact.affected_files && impact.affected_files.length > 0 && (
            <Card title="Affected Files">
              <div className="space-y-2">
                {impact.affected_files.map((file: any, idx: number) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{file.file_path}</p>
                      <p className="text-sm text-gray-600">
                        {file.impact_type} • Distance: {file.distance}
                      </p>
                    </div>
                    <Badge variant="warning">{file.confidence}%</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {impact.test_files && impact.test_files.length > 0 && (
            <Card title="Test Files to Run">
              <div className="space-y-2">
                {impact.test_files.map((file: string, idx: number) => (
                  <div key={idx} className="p-2 bg-blue-50 rounded text-sm font-mono">
                    {file}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {impact.recommendations && impact.recommendations.length > 0 && (
            <Card title="Recommendations">
              <ul className="space-y-2">
                {impact.recommendations.map((rec: string, idx: number) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-primary-600">•</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : null}
    </div>
  )
}