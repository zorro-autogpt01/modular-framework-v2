import { useEffect, useState } from 'react'
import { api } from '../services/api'
import type { Repository } from '../types'

export default function Repositories() {
  const [repos, setRepos] = useState<Repository[]>([])
  const [name, setName] = useState('')
  const [sourceType, setSourceType] = useState('local')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('all')

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.listRepositories({ status })
      setRepos(res.data.repositories)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [status])

  const registerRepo = async () => {
    if (!name) return
    await api.registerRepository({ name, source_type: sourceType })
    setName('')
    await load()
  }

  const indexRepo = async (id: string) => {
    await api.indexRepository(id, { mode: 'incremental' })
    await load()
  }

  const deleteRepo = async (id: string) => {
    await api.deleteRepository(id)
    await load()
  }

  return (
    <div>
      <div className="card">
        <h3>Register Repository</h3>
        <div className="row">
          <input className="input" placeholder="Repository name" value={name} onChange={e => setName(e.target.value)} />
          <select className="input" value={sourceType} onChange={e => setSourceType(e.target.value)}>
            <option value="local">local</option>
            <option value="git">git</option>
          </select>
          <button className="button" onClick={registerRepo}>Register</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label>
          Status:
          <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">all</option>
            <option value="registered">registered</option>
            <option value="indexing">indexing</option>
            <option value="indexed">indexed</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <button className="button" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th><th>Name</th><th>Status</th><th>Created</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {repos.map(r => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.name}</td>
              <td>{r.status}</td>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td className="row">
                <button className="button" onClick={() => indexRepo(r.id)}>Index</button>
                <button className="button" onClick={() => deleteRepo(r.id)} style={{ background: '#e03131', borderColor: '#e03131' }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
