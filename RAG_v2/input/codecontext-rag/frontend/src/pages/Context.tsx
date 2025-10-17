import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { CodeBlock } from '../components/shared/CodeBlock'
import { MermaidDiagram } from '../components/shared/MermaidDiagram'
import { api } from '../services/api'
import { FileCode, Layers } from 'lucide-react'
import type { Repository, ContextChunk } from '../types/index'

export const Context: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [query, setQuery] = useState('how does authentication work?')
  const [maxChunks, setMaxChunks] = useState(8)
  const [retrievalMode, setRetrievalMode] = useState<'vector' | 'callgraph' | 'slice'>('vector')
  const [chunks, setChunks] = useState<ContextChunk[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [artifacts, setArtifacts] = useState<any[]>([])
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

  const getContext = async () => {
    if (!selectedRepo || !query) return

    try {
      setLoading(true)
      setError('')
      const data = await api.getContext(selectedRepo, {
        query,
        max_chunks: maxChunks,
        expand_neighbors: true,
        retrieval_mode: retrievalMode,
        call_graph_depth: 2
      })
      setChunks(data.chunks || [])
      setSummary(data.summary || null)
      setArtifacts(data.artifacts || [])
    } catch (err: any) {
      setError(err.message || 'Failed to get context')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Context Retrieval">
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
              Query
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder="What context do you need?"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Max Chunks
              </label>
              <input
                type="number"
                min="1"
                max="50"
                value={maxChunks}
                onChange={(e) => setMaxChunks(parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Retrieval Mode
              </label>
              <select
                value={retrievalMode}
                onChange={(e) => setRetrievalMode(e.target.value as any)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="vector">Vector</option>
                <option value="callgraph">Call Graph</option>
                <option value="slice">Program Slice</option>
              </select>
            </div>
          </div>

          <Button
            icon={<Layers className="w-4 h-4" />}
            onClick={getContext}
            loading={loading}
            disabled={!selectedRepo || !query}
          >
            Get Context
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={getContext} />}

      {loading ? (
        <LoadingSpinner text="Retrieving context..." />
      ) : (
        <>
          {summary && (
            <Card>
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <p className="text-sm text-gray-600">Total Chunks</p>
                  <p className="text-2xl font-bold text-gray-900">{summary.total_chunks}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Avg Confidence</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Math.round(summary.avg_confidence)}%
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Mode</p>
                  <p className="text-lg font-semibold text-gray-900">{summary.retrieval_mode}</p>
                </div>
              </div>
            </Card>
          )}

          {artifacts.length > 0 && (
            <Card title="Artifacts">
              <div className="space-y-4">
                {artifacts.map((artifact, idx) => (
                  <div key={idx}>
                    <p className="text-sm text-gray-600 mb-2">
                      {artifact.label} ({artifact.type})
                    </p>
                    {artifact.type === 'mermaid' ? (
                      <MermaidDiagram chart={artifact.content} />
                    ) : (
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-sm max-h-[400px]">
                        {artifact.content}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {chunks.length > 0 && (
            <div className="space-y-4">
              {chunks.map((chunk, idx) => (
                <Card key={idx}>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <FileCode className="w-5 h-5 text-primary-600" />
                        <div>
                          <p className="font-semibold text-gray-900">{chunk.file_path}</p>
                          <p className="text-sm text-gray-600">
                            Lines {chunk.start_line}-{chunk.end_line} • {chunk.language}
                          </p>
                        </div>
                      </div>
                      <Badge variant="success">{chunk.confidence}%</Badge>
                    </div>
                    <CodeBlock code={chunk.snippet} language={chunk.language} />
                    {chunk.reasons && chunk.reasons.length > 0 && (
                      <div className="text-sm text-gray-600">
                        {chunk.reasons.map((reason, ridx) => (
                          <div key={ridx}>• {reason.explanation}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}