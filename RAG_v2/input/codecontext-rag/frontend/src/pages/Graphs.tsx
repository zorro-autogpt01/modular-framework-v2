import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { MermaidDiagram } from '../components/shared/MermaidDiagram'
import { api } from '../services/api'
import { Map, RefreshCw } from 'lucide-react'
import type { Repository } from '../types/index'

export const Graphs: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [graphType, setGraphType] = useState<'dependency' | 'module' | 'class' | 'call'>('dependency')
  const [format, setFormat] = useState<'json' | 'mermaid' | 'plantuml'>('mermaid')
  const [nodeFilter, setNodeFilter] = useState('')
  const [depth, setDepth] = useState(0)
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

  const loadGraph = async () => {
    if (!selectedRepo) return

    try {
      setLoading(true)
      setError('')
      const result = await api.getGraph(selectedRepo, graphType, format, nodeFilter, depth)
      setData(result)
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setError('Graph not available. Please reindex the repository, then try again.')
      } else {
        setError(err.message || 'Failed to load graph')
      }
    } finally {
      setLoading(false)
    }
  }

  const reindex = async () => {
    if (!selectedRepo) return
    try {
      await api.reindexRepository(selectedRepo)
      alert('Reindexing started. Try again in ~1 minute.')
    } catch (err: any) {
      setError(err.message || 'Failed to start reindexing')
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Code Graphs" actions={
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Graph Type
              </label>
              <select
                value={graphType}
                onChange={(e) => setGraphType(e.target.value as any)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="dependency">Dependency</option>
                <option value="module">Module</option>
                <option value="class">Class</option>
                <option value="call">Call</option>
              </select>
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Node Filter (optional)
              </label>
              <input
                type="text"
                value={nodeFilter}
                onChange={(e) => setNodeFilter(e.target.value)}
                placeholder="Filter by node ID..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Depth (0 = all)
              </label>
              <input
                type="number"
                min="0"
                max="5"
                value={depth}
                onChange={(e) => setDepth(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <Button
            icon={<Map className="w-4 h-4" />}
            onClick={loadGraph}
            loading={loading}
            disabled={!selectedRepo}
          >
            Load Graph
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={loadGraph} />}

      {loading ? (
        <LoadingSpinner text="Loading graph..." />
      ) : data ? (
        <Card title={`${graphType} Graph`}>
          {format === 'mermaid' && (data as any).graph_text ? (
            <div className="overflow-auto">
              <MermaidDiagram chart={(data as any).graph_text} />
            </div>
          ) : format === 'plantuml' && (data as any).graph_text ? (
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-sm max-h-[600px]">
              {(data as any).graph_text}
            </pre>
          ) : (data as any).graph ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Nodes</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {(data as any).graph.nodes?.length || 0}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Edges</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {(data as any).graph.edges?.length || 0}
                  </p>
                </div>
              </div>
              <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-sm max-h-[600px]">
                {JSON.stringify((data as any).graph, null, 2)}
              </pre>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}