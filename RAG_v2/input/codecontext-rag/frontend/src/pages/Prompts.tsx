import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { api } from '../services/api'
import { MessageSquare, Copy, Check } from 'lucide-react'
import type { Repository } from '../types/index'

export const Prompts: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [query, setQuery] = useState('implement user password reset functionality')
  const [messages, setMessages] = useState<any[]>([])
  const [tokenUsage, setTokenUsage] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [copied, setCopied] = useState(false)

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

  const buildPrompt = async () => {
    if (!selectedRepo || !query) return

    try {
      setLoading(true)
      setError('')
      const data = await api.buildPrompt(selectedRepo, {
        query,
        options: {
          max_chunks: 12,
          include_dependency_expansion: true,
          retrieval_mode: 'vector'
        }
      })
      setMessages(data.messages || [])
      setTokenUsage(data.token_usage || null)
    } catch (err: any) {
      setError(err.message || 'Failed to build prompt')
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = () => {
    const text = messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      <Card title="Prompt Builder">
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
              Task Description
            </label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder="What do you want to build?"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <Button
            icon={<MessageSquare className="w-4 h-4" />}
            onClick={buildPrompt}
            loading={loading}
            disabled={!selectedRepo || !query}
          >
            Build Prompt
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={buildPrompt} />}

      {loading ? (
        <LoadingSpinner text="Building prompt..." />
      ) : messages.length > 0 ? (
        <>
          {tokenUsage && (
            <Card>
              <div className="grid grid-cols-4 gap-6">
                <div>
                  <p className="text-sm text-gray-600">Budget</p>
                  <p className="text-2xl font-bold text-gray-900">{tokenUsage.budget}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Estimated Tokens</p>
                  <p className="text-2xl font-bold text-gray-900">{tokenUsage.estimated_tokens}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Chunks Included</p>
                  <p className="text-2xl font-bold text-gray-900">{tokenUsage.chunks_included}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Model</p>
                  <p className="text-lg font-semibold text-gray-900">{tokenUsage.model}</p>
                </div>
              </div>
            </Card>
          )}

          <Card
            title={`Messages (${messages.length})`}
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                onClick={copyToClipboard}
              >
                {copied ? 'Copied!' : 'Copy All'}
              </Button>
            }
          >
            <div className="space-y-4 max-h-[600px] overflow-y-auto">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`p-4 rounded-lg ${
                    msg.role === 'system'
                      ? 'bg-blue-50 border border-blue-200'
                      : 'bg-purple-50 border border-purple-200'
                  }`}
                >
                  <p className="text-xs font-semibold text-gray-600 mb-2">
                    {msg.role.toUpperCase()}
                  </p>
                  <pre className="text-sm text-gray-800 whitespace-pre-wrap font-mono">
                    {msg.content.length > 1000
                      ? msg.content.substring(0, 1000) + '...'
                      : msg.content}
                  </pre>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  )
}
