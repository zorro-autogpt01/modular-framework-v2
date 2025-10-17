import React, { useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { api } from '../services/api'
import { Beaker, Play } from 'lucide-react'
import type { Repository } from '../types/index'

export const Tests: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [filesText, setFilesText] = useState('src/auth/login.py')
  const [rankedTests, setRankedTests] = useState<any[]>([])
  const [testOutput, setTestOutput] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
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

  const selectTests = async () => {
    if (!selectedRepo || !filesText) return

    const files = filesText.split('\n').map(f => f.trim()).filter(Boolean)

    try {
      setLoading(true)
      setError('')
      const data = await api.selectTests(selectedRepo, { modified_files: files })
      setRankedTests(data.ranked_tests || [])
    } catch (err: any) {
      setError(err.message || 'Failed to select tests')
    } finally {
      setLoading(false)
    }
  }

  const runTests = async () => {
    if (!selectedRepo || rankedTests.length === 0) return

    const tests = rankedTests
      .filter(t => t.score > 0)
      .slice(0, 10)
      .map(t => t.test)

    try {
      setRunning(true)
      setError('')
      const data = await api.runTests(selectedRepo, { tests })
      setTestOutput(data.output || '')
    } catch (err: any) {
      setError(err.message || 'Failed to run tests')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Test Selection">
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
              rows={4}
              placeholder="src/auth/login.py"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 font-mono text-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              icon={<Beaker className="w-4 h-4" />}
              onClick={selectTests}
              loading={loading}
              disabled={!selectedRepo || !filesText}
            >
              Select Tests
            </Button>
            {rankedTests.length > 0 && (
              <Button
                icon={<Play className="w-4 h-4" />}
                variant="success"
                onClick={runTests}
                loading={running}
              >
                Run Selected Tests
              </Button>
            )}
          </div>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={selectTests} />}

      {loading ? (
        <LoadingSpinner text="Selecting tests..." />
      ) : rankedTests.length > 0 ? (
        <Card title={`Ranked Tests (${rankedTests.length})`}>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {rankedTests.slice(0, 20).map((test, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <span className="font-mono text-sm text-gray-700">{test.test}</span>
                <Badge variant={test.score > 0.7 ? 'success' : 'warning'}>
                  {test.score.toFixed(2)}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {running && <LoadingSpinner text="Running tests..." />}

      {testOutput && (
        <Card title="Test Output">
          <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-sm max-h-[600px] whitespace-pre-wrap">
            {testOutput}
          </pre>
        </Card>
      )}
    </div>
  )
}