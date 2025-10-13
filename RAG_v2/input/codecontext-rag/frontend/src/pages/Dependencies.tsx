import { useEffect, useState } from 'react'
import { api } from '../services/api'

export default function Dependencies() {
  const [repos, setRepos] = useState<any[]>([])
  const [repoId, setRepoId] = useState('')
  const [filePath, setFilePath] = useState('src/auth/login.py')
  const [depth, setDepth] = useState(2)
  const [data, setData] = useState<any | null>(null)

  useEffect(() => { api.listRepositories({}).then(r => setRepos(r.data.repositories)) }, [])

  const run = async () => {
    if (!repoId || !filePath) return
    const res = await api.dependencies(filePath, repoId, depth)
    setData(res.data)
  }

  return (
    <div>
      <div className="card">
        <h3>Get File Dependencies</h3>
        <div className="row">
          <select className="input" value={repoId} onChange={e => setRepoId(e.target.value)}>
            <option value="">Select repo</option>
            {repos.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input className="input" placeholder="file path" value={filePath} onChange={e => setFilePath(e.target.value)} style={{ flex: 1 }} />
          <input className="input" type="number" min={1} max={5} value={depth} onChange={e => setDepth(Number(e.target.value))} />
          <button className="button" onClick={run}>Fetch</button>
        </div>
      </div>
      {data && (
        <div className="card">
          <h4>{data.file_path}</h4>
          <pre>{JSON.stringify(data.graph, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
