import React, { useEffect, useState } from 'react'
import { Card } from '../components/shared/Card'
import { Button } from '../components/shared/Button'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { ErrorMessage } from '../components/shared/ErrorMessage'
import { api } from '../services/api'
import { Plus, RefreshCw, Trash2, GitBranch } from 'lucide-react'
import type { Repository } from '../types/index'

export const Repositories: React.FC = () => {
  const [repos, setRepos] = useState<Repository[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [addForm, setAddForm] = useState({
    connection_id: '',
    branch: '',
    auto_index: true
  })

  useEffect(() => {
    loadRepos()
  }, [])

  const loadRepos = async () => {
    try {
      setLoading(true)
      setError('')
      const data = await api.listRepositories()
      setRepos(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load repositories')
    } finally {
      setLoading(false)
    }
  }

  const addRepo = async () => {
    if (!addForm.connection_id) {
      setError('Connection ID is required')
      return
    }

    try {
      setError('')
      await api.addRepository(addForm)
      setShowAddModal(false)
      setAddForm({ connection_id: '', branch: '', auto_index: true })
      loadRepos()
    } catch (err: any) {
      setError(err.message || 'Failed to add repository')
    }
  }

  const deleteRepo = async (id: string) => {
    if (!confirm('Are you sure you want to delete this repository?')) return

    try {
      await api.deleteRepository(id)
      loadRepos()
    } catch (err: any) {
      setError(err.message || 'Failed to delete repository')
    }
  }

  const reindexRepo = async (id: string) => {
    try {
      await api.reindexRepository(id)
      alert('Reindexing started')
      loadRepos()
    } catch (err: any) {
      setError(err.message || 'Failed to start reindexing')
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'indexed':
        return <Badge variant="success">Indexed</Badge>
      case 'indexing':
        return <Badge variant="warning">Indexing...</Badge>
      case 'error':
        return <Badge variant="danger">Error</Badge>
      default:
        return <Badge>Pending</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Repositories</h2>
            <p className="mt-1 text-sm text-gray-600">
              Manage your connected code repositories
            </p>
          </div>
          <Button 
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setShowAddModal(true)}
          >
            Add Repository
          </Button>
        </div>
      </Card>

      {error && <ErrorMessage message={error} onRetry={loadRepos} />}

      {loading ? (
        <LoadingSpinner text="Loading repositories..." />
      ) : repos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <GitBranch className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600 mb-2">No repositories yet</p>
            <p className="text-sm text-gray-500 mb-6">
              Add your first repository to get started
            </p>
            <Button 
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setShowAddModal(true)}
            >
              Add Repository
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {repos.map(repo => (
            <Card key={repo.id}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center">
                    <GitBranch className="w-6 h-6 text-primary-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {repo.full_name || repo.name}
                    </h3>
                    <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
                      <span>Branch: {repo.branch}</span>
                      {repo.indexed_at && (
                        <span>
                          Last indexed: {new Date(repo.indexed_at).toLocaleString()}
                        </span>
                      )}
                      {repo.statistics && (
                        <span>
                          {repo.statistics.indexed_files} / {repo.statistics.total_files} files
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {getStatusBadge(repo.status)}
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<RefreshCw className="w-4 h-4" />}
                    onClick={() => reindexRepo(repo.id)}
                  >
                    Reindex
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="w-4 h-4" />}
                    onClick={() => deleteRepo(repo.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add Repository Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              Add Repository
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  GitHub Hub Connection ID *
                </label>
                <input
                  type="text"
                  value={addForm.connection_id}
                  onChange={(e) => setAddForm({ ...addForm, connection_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="my-github-connection"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Branch (optional)
                </label>
                <input
                  type="text"
                  value={addForm.branch}
                  onChange={(e) => setAddForm({ ...addForm, branch: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="main"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="auto-index"
                  checked={addForm.auto_index}
                  onChange={(e) => setAddForm({ ...addForm, auto_index: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="auto-index" className="text-sm text-gray-700">
                  Automatically index after adding
                </label>
              </div>
            </div>
            <div className="flex items-center gap-3 mt-6">
              <Button onClick={addRepo} className="flex-1">
                Add Repository
              </Button>
              <Button 
                variant="secondary" 
                onClick={() => {
                  setShowAddModal(false)
                  setError('')
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}