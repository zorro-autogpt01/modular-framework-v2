
import { useEffect, useState } from 'react'
import { api } from '../services/api'

export default function Impact() {
  const [repos, setRepos] = useState<any[]>([])
  const [repoId, setRepoId] = useState('')
  const [filesText, setFilesText] = useState('src/models/user.py')
  const [resp, setResp] = useState<any | null>(null)

  useEffect(() => { api.listRepositories({}).then(r => setRepos(r.repositories)).catch(() => setRepos([])) }, [])

  const run = async () => {
    if (!repoId) return
    const modified_files = filesText.split(/\n|,/).map(s => s.trim()).filter(Boolean)
    const res = await api.impact({ repository_id: repoId, modified_files, analysis_depth: 2 })
    setResp(res.data)
  }

  return (
    <div>
      <div className="card">
        <h3>Change Impact Analysis</h3>
        <div className="row">
          <select className="input" value={repoId} onChange={e => setRepoId(e.target.value)}>
            <option value="">Select repo</option>
            {repos.map((r: any) => <option key={r.id} value={r.id}>{r.full_name || r.name}</option>)}
          </select>
          <textarea className="input" style={{ flex: 1, minHeight: 80 }} value={filesText} onChange={e => setFilesText(e.target.value)} />
          <button className="button" onClick={run}>Analyze</button>
        </div>
      </div>
      {resp && (
        <div className="card">
          <h4>Risk: {resp.impact?.risk_level}</h4>
          <pre>{JSON.stringify(resp.impact, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}