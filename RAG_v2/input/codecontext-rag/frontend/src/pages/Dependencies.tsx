import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { MermaidDiagram } from '../components/shared/MermaidDiagram'
import { api } from '../services/api'
import { Network, FileCode, RefreshCw } from 'lucide-react'
import type { Repository } from '../types/index'

export const Dependencies: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [filePath, setFilePath] = useState('src/auth/login.py')
  const [depth, setDepth] = useState(2)
  const [format, setFormat] = useState<'json' | 'mermaid' | 'plantuml'>('mermaid')
  const [data, setData] = useState<any>(null)
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
    if (!selectedRepo || !filePath) return

    try {
      setLoading(true)
      setError('')
      const result = await api.getDependencies(filePath, selectedRepo, depth, format)
      setData(result)
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setError('Dependency graph not available. Please reindex the repository, then try again.')
      } else {
        setError(err.message || 'Failed to analyze dependencies')
      }
    } finally {
      setLoading(false)
    }
  }

  const reindex = async () => {
    if (!selectedRepo) return
    try {
      await api.reindexRepository(selectedRepo)
      alert('Reindexing started. Come back in a minute and try again.')
    } catch (err: any) {
      setError(err.message || 'Failed to start reindexing')
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Dependency Analysis" actions={
        <Button size="sm" variant="secondary" icon={<RefreshCw className="w-4 h-4" />} onClick={reindex}>
          Reindex
        </Button>
      }>
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
              File Path
            </label>
            <input
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="src/main.py"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Depth
              </label>
              <input
                type="number"
                min="1"
                max="5"
                value={depth}
                onChange={(e) => setDepth(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Format
              </label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as any)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="json">JSON</option>
                <option value="mermaid">Mermaid</option>
                <option value="plantuml">PlantUML</option>
              </select>
            </div>
          </div>

          <Button
            icon={<Network className="w-4 h-4" />}
            onClick={analyze}
            loading={loading}
            disabled={!selectedRepo || !filePath}
          >
            Analyze
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={analyze} />}

      {loading ? (
        <LoadingSpinner text="Analyzing dependencies..." />
      ) : data ? (
        <Card title="Results">
          {format === 'mermaid' && (data as any).graph_text ? (
            <MermaidDiagram chart={(data as any).graph_text} />
          ) : format === 'plantuml' && (data as any).graph_text ? (
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-sm">
              {(data as any).graph_text}
            </pre>
          ) : (data as any).graph ? (
            <>
              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <h4 className="font-semibold text-gray-900 mb-3">Imports</h4>
                  <div className="space-y-2">
                    {(data as any).graph.nodes
                      ?.filter((n: any) => n.type === 'import')
                      .map((node: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 p-2 bg-blue-50 rounded">
                          <FileCode className="w-4 h-4 text-blue-600" />
                          <span className="text-sm text-gray-700">{node.label}</span>
                        </div>
                      ))}
                  </div>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 mb-3">Imported By</h4>
                  <div className="space-y-2">
                    {(data as any).graph.nodes
                      ?.filter((n: any) => n.type === 'imported_by')
                      .map((node: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 p-2 bg-green-50 rounded">
                          <FileCode className="w-4 h-4 text-green-600" />
                          <span className="text-sm text-gray-700">{node.label}</span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>

              {(data as any).statistics && (
                <div className="pt-6 border-t border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-3">Statistics</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-sm text-gray-600">Total Dependencies</p>
                      <p className="text-xl font-bold text-gray-900">
                        {(data as any).statistics.total_dependencies}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Depth</p>
                      <p className="text-xl font-bold text-gray-900">
                        {(data as any).statistics.depth}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Circular Dependencies</p>
                      <p className="text-xl font-bold text-red-600">
                        {(data as any).statistics.circular_dependencies?.length || 0}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
