import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { CodeBlock } from '../components/shared/CodeBlock'
import { api } from '../services/api'
import { Search as SearchIcon, FileCode } from 'lucide-react'
import type { Repository } from '../types/index'

interface SearchResult {
  file_path: string
  entity_type: string
  entity_name?: string
  similarity_score: number
  code_snippet: string
  line_number: number
}

export const Search: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
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

  const search = async () => {
    if (!selectedRepo || !query) {
      setError('Please select a repository and enter a query')
      return
    }

    try {
      setLoading(true)
      setError('')
      const data = await api.searchCode({
        repository_id: selectedRepo,
        query,
        search_type: 'semantic',
        max_results: 10
      })
      setResults(data.results || [])
    } catch (err: any) {
      setError(err.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Search Form */}
      <Card>
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
              Search Query
            </label>
            <div className="flex gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && search()}
                placeholder="Find functions that validate email addresses..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <Button
                icon={<SearchIcon className="w-4 h-4" />}
                onClick={search}
                loading={loading}
                disabled={!selectedRepo || !query}
              >
                Search
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={search} />}

      {loading ? (
        <LoadingSpinner text="Searching..." />
      ) : results.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Found {results.length} results
            </p>
          </div>

          <div className="space-y-4">
            {results.map((result, idx) => (
              <Card key={idx}>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileCode className="w-5 h-5 text-primary-600" />
                      <div>
                        <p className="font-medium text-gray-900">{result.file_path}</p>
                        {result.entity_name && (
                          <p className="text-sm text-gray-600">
                            {result.entity_type}: {result.entity_name}
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge variant="success">
                      {Math.round(result.similarity_score * 100)}% match
                    </Badge>
                  </div>
                  <CodeBlock code={result.code_snippet} language="python" />
                  <p className="text-xs text-gray-500">
                    Line {result.line_number}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}