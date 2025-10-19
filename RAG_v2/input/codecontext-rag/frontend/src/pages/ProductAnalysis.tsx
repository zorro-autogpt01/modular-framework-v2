import React, { useEffect, useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { SuggestionCard } from '../components/features/SuggestionCard'
import { ConversationThread } from '../components/features/ConversationThread'
import { api } from '../services/api'
import { Play, Sparkles, TrendingUp, MessageSquare } from 'lucide-react'
import type { Repository, FeatureSuggestion, ConversationMessage, AgentAnalysis } from '../types/index'

export const ProductAnalysis: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [suggestions, setSuggestions] = useState<FeatureSuggestion[]>([])
  const [analyses, setAnalyses] = useState<AgentAnalysis[]>([])
  const [conversation, setConversation] = useState<ConversationMessage[]>([])
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    loadRepos()
  }, [])

  useEffect(() => {
    if (selectedRepo) {
      loadData()
    }
  }, [selectedRepo])

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

  const loadData = async () => {
    if (!selectedRepo) return

    try {
      setLoading(true)
      setError('')

      const [suggestionsData, analysesData] = await Promise.all([
        api.listSuggestions(selectedRepo),
        api.listAnalyses(selectedRepo)
      ])

      setSuggestions(suggestionsData.suggestions || [])
      setAnalyses(analysesData.analyses || [])
    } catch (err: any) {
      setError(err.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const runAnalysis = async () => {
    if (!selectedRepo) return

    try {
      setRunning(true)
      setError('')
      await api.triggerProductAnalysis(selectedRepo, false)

      setTimeout(() => {
        loadData()
        setRunning(false)
      }, 5000)
    } catch (err: any) {
      setError(err.message || 'Failed to start analysis')
      setRunning(false)
    }
  }

  const loadConversation = async (suggestionId: string) => {
    try {
      const data = await api.getSuggestionDetail(selectedRepo, suggestionId)
      setConversation(data.conversation || [])
    } catch (err: any) {
      setError(err.message || 'Failed to load conversation')
    }
  }

  const updateSuggestionStatus = async (suggestionId: string, status: string) => {
    try {
      await api.updateSuggestionStatus(selectedRepo, suggestionId, status)
      loadData()
    } catch (err: any) {
      setError(err.message || 'Failed to update status')
    }
  }

  const pendingSuggestions = suggestions.filter(s => s.status === 'proposed')
  const approvedSuggestions = suggestions.filter(s => s.status === 'approved')
  const pmAnalysis = analyses.find(a => a.agent_role === 'Product Manager')
  const marketerAnalysis = analyses.find(a => a.agent_role === 'Growth Marketer')

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Product Analysis</h2>
            <p className="mt-1 text-sm text-gray-600">
              AI-powered product insights from PM and Marketer agents
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Select repository...</option>
              {repos.map(repo => (
                <option key={repo.id} value={repo.id}>
                  {repo.full_name || repo.name}
                </option>
              ))}
            </select>
            <Button
              icon={<Play className="w-4 h-4" />}
              onClick={runAnalysis}
              loading={running}
              disabled={!selectedRepo}
            >
              Run Analysis
            </Button>
          </div>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={loadData} />}

      {loading ? (
        <LoadingSpinner text="Loading analysis results..." />
      ) : (
        <>
          {(pmAnalysis || marketerAnalysis) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {pmAnalysis && (
                <Card
                  title="Product Manager Analysis"
                  actions={<Badge variant="info">PM Agent</Badge>}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <TrendingUp className="w-4 h-4" />
                      <span>{new Date(pmAnalysis.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-gray-700">{pmAnalysis.summary}</p>
                    <details className="text-sm">
                      <summary className="cursor-pointer text-primary-600 hover:text-primary-700">
                        View full analysis
                      </summary>
                      <div className="mt-2 p-3 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap">
                        {JSON.stringify(pmAnalysis.details, null, 2)}
                      </div>
                    </details>
                  </div>
                </Card>
              )}

              {marketerAnalysis && (
                <Card
                  title="Growth Marketer Analysis"
                  actions={<Badge variant="success">Marketer Agent</Badge>}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Sparkles className="w-4 h-4" />
                      <span>{new Date(marketerAnalysis.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-gray-700">{marketerAnalysis.summary}</p>
                    <details className="text-sm">
                      <summary className="cursor-pointer text-primary-600 hover:text-primary-700">
                        View full analysis
                      </summary>
                      <div className="mt-2 p-3 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap">
                        {JSON.stringify(marketerAnalysis.details, null, 2)}
                      </div>
                    </details>
                  </div>
                </Card>
              )}
            </div>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">
                  Feature Suggestions
                </h3>
                <div className="flex items-center gap-2">
                  <Badge variant="warning">{pendingSuggestions.length} pending</Badge>
                  <Badge variant="success">{approvedSuggestions.length} approved</Badge>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                {suggestions.map(suggestion => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    onStatusChange={(status) => updateSuggestionStatus(suggestion.id, status)}
                    onViewDetails={() => loadConversation(suggestion.id)}
                  />
                ))}
              </div>
            </>
          )}

          {conversation.length > 0 && (
            <ConversationThread messages={conversation} />
          )}

          {!loading && suggestions.length === 0 && analyses.length === 0 && (
            <Card>
              <div className="text-center py-12">
                <MessageSquare className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600 mb-2">No analysis results yet</p>
                <p className="text-sm text-gray-500 mb-6">
                  Run product analysis to get AI-powered insights
                </p>
                <Button
                  icon={<Play className="w-4 h-4" />}
                  onClick={runAnalysis}
                  loading={running}
                  disabled={!selectedRepo}
                >
                  Run Analysis Now
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
