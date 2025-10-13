import { useEffect, useState } from 'react'
import { api } from '../services/api'

export default function Recommendations() {
  const [repos, setRepos] = useState<any[]>([])
  const [repoId, setRepoId] = useState('')
  const [query, setQuery] = useState('implement user authentication with email and password')
  const [results, setResults] = useState<any | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.listRepositories({ status: 'all' }).then(r => setRepos(r.data.repositories))
  }, [])

  const recommend = async () => {
    if (!repoId || !query) return
    setLoading(true)
    try {
      const res = await api.recommendations({ repository_id: repoId, query, max_results: 10 })
      setResults(res.data)
    } finally { setLoading(false) }
  }

  return (
    <div>
      <div className="card">
        <h3>Get File Recommendations</h3>
        <div className="row">
          <select className="input" value={repoId} onChange={e => setRepoId(e.target.value)}>
            <option value="">Select repo</option>
            {repos.map(r => <option key={r.id} value={r.id}>{r.name} ({r.id})</option>)}
          </select>
          <input className="input" value={query} onChange={e => setQuery(e.target.value)} style={{ flex: 1 }} />
          <button className="button" onClick={recommend} disabled={loading}>{loading ? 'Loading...' : 'Recommend'}</button>
        </div>
      </div>
      {results && (
        <div className="card">
          <h4>Session: {results.session_id}</h4>
          <p>Query: {results.query}</p>
          <p>Summary: {results.summary?.total_files} files, avg confidence {results.summary?.avg_confidence?.toFixed?.(1)}</p>
          <table className="table">
            <thead><tr><th>File</th><th>Confidence</th><th>Reasons</th></tr></thead>
            <tbody>
              {results.recommendations.map((r: any) => (
                <tr key={r.file_path}>
                  <td>{r.file_path}</td>
                  <td>{r.confidence}</td>
                  <td>
                    <ul>
                      {(r.reasons || []).map((rs: any, idx: number) => (
                        <li key={idx}><b>{rs.type}</b> ({rs.score}): {rs.explanation}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
