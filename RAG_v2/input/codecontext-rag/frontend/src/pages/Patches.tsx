import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { CodeBlock } from '../components/shared/CodeBlock'
import { api } from '../services/api'
import { GitPullRequest, CheckCircle, XCircle } from 'lucide-react'
import type { Repository } from '../types/index'

export const Patches: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [query, setQuery] = useState('add input validation to the login form')
  const [patch, setPatch] = useState<string>('')
  const [validation, setValidation] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
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

  const generatePatch = async () => {
    if (!selectedRepo || !query) return

    try {
      setLoading(true)
      setError('')
      const data = await api.generatePatch(selectedRepo, {
        query,
        temperature: 0.2,
        max_output_tokens: 2000,
        force_unified_diff: true
      })
      setPatch(data.patch || '')
      setValidation(data.validation || null)
    } catch (err: any) {
      setError(err.message || 'Failed to generate patch')
    } finally {
      setLoading(false)
    }
  }

  const applyPatch = async () => {
    if (!patch) return

    try {
      setApplying(true)
      setError('')
      await api.applyPatch(selectedRepo, {
        patch,
        commit_message: `Auto-patch: ${query}`,
        push: false,
        create_pr: false,
        dry_run: false
      })
      alert('Patch applied successfully!')
    } catch (err: any) {
      setError(err.message || 'Failed to apply patch')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Patch Generator">
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
              Change Description
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder="Describe the changes you want..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <Button
            icon={<GitPullRequest className="w-4 h-4" />}
            onClick={generatePatch}
            loading={loading}
            disabled={!selectedRepo || !query}
          >
            Generate Patch
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={generatePatch} />}

      {loading ? (
        <LoadingSpinner text="Generating patch..." />
      ) : patch ? (
        <>
          {validation && (
            <Card title="Validation">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  {validation.ok ? (
                    <>
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-green-700">Valid patch</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-5 h-5 text-red-600" />
                      <span className="font-medium text-red-700">Issues found</span>
                    </>
                  )}
                </div>

                {validation.files && validation.files.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Files affected:</p>
                    <div className="flex flex-wrap gap-2">
                      {validation.files.map((file: string, idx: number) => (
                        <Badge key={idx}>{file}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {validation.issues && validation.issues.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Issues:</p>
                    <ul className="space-y-1">
                      {validation.issues.map((issue: string, idx: number) => (
                        <li key={idx} className="text-sm text-red-600">• {issue}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {validation.ok && (
                  <Button
                    variant="success"
                    onClick={applyPatch}
                    loading={applying}
                  >
                    Apply Patch
                  </Button>
                )}
              </div>
            </Card>
          )}

          <Card title="Generated Patch">
            <CodeBlock code={patch} language="diff" maxHeight="600px" />
          </Card>
        </>
      ) : null}
    </div>
  )
}