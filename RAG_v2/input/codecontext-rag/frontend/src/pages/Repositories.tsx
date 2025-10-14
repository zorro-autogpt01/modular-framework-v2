import { useEffect, useState } from 'react'
import { api } from '../services/api'
import type { Repository } from '../types'

export default function Repositories() {
  const [repos, setRepos] = useState<Repository[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [branch, setBranch] = useState('')
  const [autoIndex, setAutoIndex] = useState(true)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('all')
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listRepositories({ status })
      setRepos(res.repositories)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [status])

  const addRepo = async () => {
    if (!connectionId) {
      setError('connection_id is required')
      return
    }
    setError(null)
    try {
      await api.addRepository({
        connection_id: connectionId,
        branch: branch || undefined,
        auto_index: autoIndex
      })
      setConnectionId('')
      setBranch('')
      setAutoIndex(true)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const reindexRepo = async (id: string) => {
    setError(null)
    try {
      await api.reindexRepository(id)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const deleteRepo = async (id: string) => {
    setError(null)
    try {
      await api.deleteRepository(id)
      await load()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  return (
    <div>
      <div className="card">
        <h3>Add Repository (GitHub Hub)</h3>
        <div className="row">
          <input
            className="input"
            placeholder="connection_id (from GitHub Hub)"
            value={connectionId}
            onChange={e => setConnectionId(e.target.value)}
            style={{ flex: 2 }}
          />
          <input
            className="input"
            placeholder="branch (optional)"
            value={branch}
            onChange={e => setBranch(e.target.value)}
            style={{ flex: 1 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={autoIndex}
              onChange={e => setAutoIndex(e.target.checked)}
            />
            Auto-index
          </label>
          <button className="button" onClick={addRepo}>Add</button>
        </div>
        {error && <div style={{ color: '#e03131', marginTop: 8 }}>{error}</div>}
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label>
          Status:
          <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">all</option>
            <option value="pending">pending</option>
            <option value="indexing">indexing</option>
            <option value="indexed">indexed</option>
            <option value="error">error</option>
          </select>
        </label>
        <button className="button" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th><th>Full Name</th><th>Branch</th><th>Status</th><th>Indexed At</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {repos.map(r => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.full_name || r.name}</td>
              <td>{r.branch || 'main'}</td>
              <td>{r.status}</td>
              <td>{r.indexed_at ? new Date(r.indexed_at).toLocaleString() : '-'}</td>
              <td className="row">
                <button className="button" onClick={() => reindexRepo(r.id)}>Reindex</button>
                <button className="button" onClick={() => deleteRepo(r.id)} style={{ background: '#e03131', borderColor: '#e03131' }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

