import React, { useState, useEffect, useRef } from 'react';
import { Search, GitBranch, FileCode, Zap, TrendingUp, Plus, Trash2, RefreshCw, Code, GitPullRequest, Network, MessageSquare, Layers } from 'lucide-react';

// API Client
const API_BASE = 'http://localhost:7998';

const api = {
  async request(endpoint, options = {}) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API Error ${response.status}: ${text || response.statusText}`);
    }
    return response.json();
  },
  
  // Repositories
  listRepos: () => api.request('/repositories'),
  addRepo: (data) => api.request('/repositories', { method: 'POST', body: JSON.stringify(data) }),
  deleteRepo: (id) => api.request(`/repositories/${id}`, { method: 'DELETE' }),
  reindexRepo: (id) => api.request(`/repositories/${id}/reindex`, { method: 'POST' }),
  getIndexStatus: (id) => api.request(`/repositories/${id}/index/status`),
  
  // Recommendations
  getRecommendations: (data) => api.request('/recommendations', { method: 'POST', body: JSON.stringify(data) }),
  interactiveRecommendations: (data) => api.request('/recommendations/interactive', { method: 'POST', body: JSON.stringify(data) }),
  refineRecommendations: (data) => api.request('/recommendations/refine', { method: 'POST', body: JSON.stringify(data) }),
  
  // Dependencies
  getDependencies: (filePath, repoId, depth = 2) => 
    api.request(`/dependencies/${encodeURIComponent(filePath)}?repository_id=${repoId}&depth=${depth}&direction=both`),
  
  // Context
  getContext: (repoId, data) => api.request(`/repositories/${repoId}/context`, { method: 'POST', body: JSON.stringify(data) }),
  
  // Prompts
  buildPrompt: (repoId, data) => api.request(`/repositories/${repoId}/prompt`, { method: 'POST', body: JSON.stringify(data) }),
  
  // Patches
  generatePatch: (repoId, data) => api.request(`/repositories/${repoId}/patch`, { method: 'POST', body: JSON.stringify(data) }),
  applyPatch: (repoId, data) => api.request(`/repositories/${repoId}/apply-patch`, { method: 'POST', body: JSON.stringify(data) }),
  
  // Search
  searchCode: (data) => api.request('/search/code', { method: 'POST', body: JSON.stringify(data) }),
};

// Helper: WebSocket URL from API_BASE
function toWsUrl(path) {
  try {
    const u = new URL(API_BASE);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = path;
    return u.toString();
  } catch {
    const isHttps = API_BASE.startsWith('https');
    const base = API_BASE.replace(/^http/, isHttps ? 'wss' : 'ws');
    return `${base}${path}`;
  }
}

// Code block with highlight.js
function CodeBlock({ code, language }) {
  const ref = useRef(null);
  useEffect(() => {
    if (window.hljs && ref.current) {
      try {
        window.hljs.highlightElement(ref.current);
      } catch {}
    }
  }, [code, language]);
  return (
    <pre className="bg-black/30 p-4 rounded-lg text-sm text-white/80 overflow-x-auto">
      <code ref={ref} className={`language-${(language || '').toLowerCase()}`}>
        {code}
      </code>
    </pre>
  );
}

// D3 Force Graph for dependencies
function D3ForceGraph({ width = 600, height = 380, nodes = [], links = [] }) {
  const ref = useRef(null);

  useEffect(() => {
    const d3 = window.d3;
    if (!d3 || !ref.current) return;
    // Clear previous SVG
    ref.current.innerHTML = '';

    const svg = d3.select(ref.current)
      .append('svg')
      .attr('width', '100%')
      .attr('height', height);

    const color = (type) => {
      if (type === 'target') return '#60a5fa';
      if (type === 'import') return '#22c55e';
      if (type === 'imported_by') return '#eab308';
      return '#a78bfa';
    };

    const sim = d3.forceSimulation(nodes.map(n => ({ ...n })))
      .force('link', d3.forceLink(links.map(l => ({ ...l }))).id(d => d.id).distance(80).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter((ref.current.clientWidth || width) / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40));

    const link = svg.append('g')
      .attr('stroke', '#888')
      .attr('stroke-opacity', 0.6)
      .selectAll('line')
      .data(links)
      .enter().append('line')
      .attr('stroke-width', 1.6);

    const node = svg.append('g')
      .selectAll('circle')
      .data(sim.nodes())
      .enter().append('circle')
      .attr('r', d => d.type === 'target' ? 10 : 7)
      .attr('fill', d => color(d.type))
      .attr('stroke', '#111')
      .attr('stroke-width', 1.2)
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      );

    const labels = svg.append('g')
      .selectAll('text')
      .data(sim.nodes())
      .enter().append('text')
      .text(d => d.label || d.id)
      .attr('fill', '#ddd')
      .attr('font-size', 11)
      .attr('dx', 12)
      .attr('dy', 4);

    sim.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);

      labels
        .attr('x', d => d.x)
        .attr('y', d => d.y);
    });

    return () => {
      try { sim.stop(); } catch {}
    };
  }, [nodes, links, width, height]);

  return <div ref={ref} className="w-full" style={{ height }} />;
}

// Main App Component
export default function App() {
  const [activeTab, setActiveTab] = useState('repositories');
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    loadRepos();
  }, []);
  
  const loadRepos = async () => {
    setLoading(true);
    try {
      const data = await api.listRepos();
      setRepos(data);
      if (data.length > 0 && !selectedRepo) {
        setSelectedRepo(data[0]);
      }
    } catch (error) {
      console.error('Failed to load repos:', error);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/20 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                <Code className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">CodeContext RAG</h1>
                <p className="text-xs text-purple-300">Intelligent Code Analysis</p>
              </div>
            </div>
            
            <select 
              className="px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              value={selectedRepo?.id || ''}
              onChange={(e) => setSelectedRepo(repos.find(r => r.id === e.target.value))}
            >
              <option value="">Select Repository</option>
              {repos.map(repo => (
                <option key={repo.id} value={repo.id}>{repo.full_name}</option>
              ))}
            </select>
          </div>
        </div>
      </header>
      
      {/* Navigation */}
      <nav className="border-b border-white/10 bg-black/10 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1 overflow-x-auto">
            <NavTab icon={Layers} label="Repositories" active={activeTab === 'repositories'} onClick={() => setActiveTab('repositories')} />
            <NavTab icon={Search} label="Search" active={activeTab === 'search'} onClick={() => setActiveTab('search')} />
            <NavTab icon={TrendingUp} label="Recommendations" active={activeTab === 'recommendations'} onClick={() => setActiveTab('recommendations')} />
            <NavTab icon={Network} label="Dependencies" active={activeTab === 'dependencies'} onClick={() => setActiveTab('dependencies')} />
            <NavTab icon={FileCode} label="Context" active={activeTab === 'context'} onClick={() => setActiveTab('context')} />
            <NavTab icon={MessageSquare} label="Prompts" active={activeTab === 'prompts'} onClick={() => setActiveTab('prompts')} />
            <NavTab icon={GitPullRequest} label="Patches" active={activeTab === 'patches'} onClick={() => setActiveTab('patches')} />
          </div>
        </div>
      </nav>
      
      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'repositories' && <RepositoriesView repos={repos} onReload={loadRepos} />}
        {activeTab === 'search' && <SearchView selectedRepo={selectedRepo} />}
        {activeTab === 'recommendations' && <RecommendationsView selectedRepo={selectedRepo} />}
        {activeTab === 'dependencies' && <DependenciesView selectedRepo={selectedRepo} />}
        {activeTab === 'context' && <ContextView selectedRepo={selectedRepo} />}
        {activeTab === 'prompts' && <PromptsView selectedRepo={selectedRepo} />}
        {activeTab === 'patches' && <PatchesView selectedRepo={selectedRepo} />}
      </main>
    </div>
  );
}

function NavTab({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
        active 
          ? 'text-purple-300 border-purple-400' 
          : 'text-white/60 border-transparent hover:text-white/80'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}

// Repositories View with WebSocket progress
function RepositoriesView({ repos, onReload }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({ connection_id: '', branch: '', auto_index: true });
  const [progressMap, setProgressMap] = useState({});
  const socketsRef = useRef({});

  useEffect(() => {
    // Auto-connect to WS for indexing repos
    repos.forEach(repo => {
      if (repo.status === 'indexing' && !socketsRef.current[repo.id]) {
        connectWS(repo.id);
      }
    });
    return () => {
      Object.values(socketsRef.current).forEach((ws) => { try { ws.close(); } catch {} });
      socketsRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  const connectWS = (repoId) => {
    const ws = new WebSocket(toWsUrl(`/ws/repositories/${repoId}/index`));
    socketsRef.current[repoId] = ws;
    ws.onopen = () => {};
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        const pct = (msg.progress && (msg.progress.percentage ?? 0)) || 0;
        setProgressMap(prev => ({ ...prev, [repoId]: { percent: pct, status: msg.status } }));
        if (msg.status === 'completed' || msg.status === 'failed') {
          try { ws.close(); } catch {}
          delete socketsRef.current[repoId];
          onReload();
        }
      } catch {}
    };
    ws.onclose = () => {};
    ws.onerror = () => {};
  };

  const handleAdd = async () => {
    try {
      await api.addRepo(formData);
      setShowAddModal(false);
      setFormData({ connection_id: '', branch: '', auto_index: true });
      onReload();
    } catch (error) {
      alert('Failed to add repository: ' + error.message);
    }
  };
  
  const handleDelete = async (id) => {
    if (!confirm('Delete this repository?')) return;
    try {
      await api.deleteRepo(id);
      onReload();
    } catch (error) {
      alert('Failed to delete: ' + error.message);
    }
  };
  
  const handleReindex = async (id) => {
    try {
      await api.reindexRepo(id);
      alert('Reindexing started!');
      onReload();
    } catch (error) {
      alert('Failed to reindex: ' + error.message);
    }
  };
  
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-white">Repositories</h2>
        <button 
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg flex items-center gap-2 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Repository
        </button>
      </div>
      
      <div className="grid gap-4">
        {repos.map(repo => {
          const p = progressMap[repo.id]?.percent ?? 0;
          const st = progressMap[repo.id]?.status || repo.status;
          return (
            <div key={repo.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6 hover:bg-white/10 transition-all">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <GitBranch className="w-5 h-5 text-purple-400" />
                    <h3 className="text-lg font-semibold text-white">{repo.full_name}</h3>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      st === 'indexed' || st === 'completed' ? 'bg-green-500/20 text-green-300' :
                      st === 'indexing' || st === 'running' ? 'bg-yellow-500/20 text-yellow-300' :
                      st === 'error' || st === 'failed' ? 'bg-red-500/20 text-red-300' :
                      'bg-gray-500/20 text-gray-300'
                    }`}>
                      {st}
                    </span>
                  </div>
                  <div className="text-sm text-white/60 space-y-1">
                    <p>Branch: <span className="text-white/80">{repo.branch}</span></p>
                    {repo.indexed_at && <p>Last indexed: <span className="text-white/80">{new Date(repo.indexed_at).toLocaleString()}</span></p>}
                  </div>
                  {(st === 'indexing' || st === 'running') && (
                    <div className="mt-4">
                      <div className="h-2 bg-white/10 rounded">
                        <div className="h-2 bg-purple-500 rounded" style={{ width: `${p}%` }} />
                      </div>
                      <p className="text-xs text-white/50 mt-1">{p.toFixed(0)}% • Real-time</p>
                    </div>
                  )}
                </div>
                
                <div className="flex gap-2">
                  <button 
                    onClick={() => handleReindex(repo.id)}
                    className="p-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 rounded-lg transition-colors"
                    title="Reindex"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => handleDelete(repo.id)}
                    className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-300 rounded-lg transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {showAddModal && (
        <Modal onClose={() => setShowAddModal(false)}>
          <h3 className="text-xl font-bold text-white mb-4">Add Repository</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">Connection ID</label>
              <input
                type="text"
                value={formData.connection_id}
                onChange={(e) => setFormData({...formData, connection_id: e.target.value})}
                className="w-full px-4 py-2 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                placeholder="GitHub Hub connection ID"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">Branch (optional)</label>
              <input
                type="text"
                value={formData.branch}
                onChange={(e) => setFormData({...formData, branch: e.target.value})}
                className="w-full px-4 py-2 bg-white/5 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                placeholder="main"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.auto_index}
                onChange={(e) => setFormData({...formData, auto_index: e.target.checked})}
                className="w-4 h-4"
              />
              <label className="text-sm text-white/80">Auto-index after adding</label>
            </div>
            <div className="flex gap-3 justify-end">
              <button 
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleAdd}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
              >
                Add Repository
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Search View with advanced filters and syntax highlighting
function SearchView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState('');
  const [dirPrefix, setDirPrefix] = useState('');
  const [maxResults, setMaxResults] = useState(20);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleSearch = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const filters = {};
      if (lang) filters.languages = [lang];
      if (dirPrefix) filters.path_prefix = dirPrefix;
      const data = await api.searchCode({
        repository_id: selectedRepo.id,
        query,
        search_type: 'semantic',
        max_results: maxResults,
        filters
      });
      setResults(data.data);
    } catch (error) {
      alert('Search failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">Code Search</h2>
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search for code patterns, functions, or features..."
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
          >
            <option value="">Any Language</option>
            <option value="python">Python</option>
            <option value="javascript">JavaScript/TS</option>
            <option value="java">Java</option>
          </select>
          <input
            type="text"
            value={dirPrefix}
            onChange={(e) => setDirPrefix(e.target.value)}
            placeholder="Directory prefix (e.g., src/api)"
            className="px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40"
          />
          <input
            type="number"
            min={1}
            max={100}
            value={maxResults}
            onChange={(e) => setMaxResults(Number(e.target.value || 20))}
            className="w-28 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
          />
          <button 
            onClick={handleSearch}
            disabled={loading || !selectedRepo}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 transition-colors"
          >
            <Search className="w-4 h-4" />
            Search
          </button>
        </div>
      </div>
      
      {results && (
        <div className="space-y-4">
          <p className="text-white/60">Found {results.total_results} results</p>
          {results.results.map((result, idx) => (
            <div key={idx} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <FileCode className="w-5 h-5 text-purple-400" />
                  <span className="text-white font-medium">{result.file_path}</span>
                </div>
                <span className="text-sm text-purple-300">Score: {(result.similarity_score * 100).toFixed(0)}%</span>
              </div>
              <CodeBlock code={result.code_snippet} language={result.language || 'plaintext'} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Recommendations View
function RecommendationsView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [recommendations, setRecommendations] = useState(null);
  const [loading, setLoading] = useState(false);
  const [interactive, setInteractive] = useState(false);
  
  const handleGetRecommendations = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const endpoint = interactive ? 'interactiveRecommendations' : 'getRecommendations';
      const data = await api[endpoint]({
        repository_id: selectedRepo.id,
        query,
        max_results: 15
      });
      setRecommendations(data.data);
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">File Recommendations</h2>
        <div className="space-y-3">
          <div className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleGetRecommendations()}
              placeholder="Describe what you're working on..."
              className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <button 
              onClick={handleGetRecommendations}
              disabled={loading || !selectedRepo}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              Get Recommendations
            </button>
          </div>
          <label className="flex items-center gap-2 text-white/80">
            <input
              type="checkbox"
              checked={interactive}
              onChange={(e) => setInteractive(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Use interactive mode (with LLM explanations)</span>
          </label>
        </div>
      </div>
      
      {recommendations && (
        <div className="space-y-4">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Summary</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-white/60">Total Files</p>
                <p className="text-xl font-bold text-white">{recommendations.summary?.total_files || recommendations.recommendations?.length || 0}</p>
              </div>
              <div>
                <p className="text-white/60">Avg Confidence</p>
                <p className="text-xl font-bold text-purple-300">{(recommendations.summary?.avg_confidence || 0).toFixed(1)}%</p>
              </div>
            </div>
            {recommendations.explanation && (
              <div className="mt-4 p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                <p className="text-sm text-purple-200">{recommendations.explanation}</p>
              </div>
            )}
          </div>
          
          <div className="space-y-3">
            {recommendations.recommendations?.map((rec, idx) => (
              <div key={idx} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-5 hover:bg-white/10 transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      rec.confidence >= 80 ? 'bg-green-400' :
                      rec.confidence >= 60 ? 'bg-yellow-400' :
                      'bg-orange-400'
                    }`}></div>
                    <span className="text-white font-medium">{rec.file_path}</span>
                  </div>
                  <span className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full text-sm font-medium">
                    {rec.confidence}% confident
                  </span>
                </div>
                
                {rec.reasons && rec.reasons.length > 0 && (
                  <div className="space-y-2">
                    {rec.reasons.map((reason, ridx) => (
                      <div key={ridx} className="flex items-start gap-2 text-sm">
                        <Zap className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
                        <span className="text-white/70">{reason.explanation}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Dependencies View with D3 graphs
function DependenciesView({ selectedRepo }) {
  const [filePath, setFilePath] = useState('');
  const [depth, setDepth] = useState(2);
  const [dependencies, setDependencies] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleGetDeps = async () => {
    if (!selectedRepo || !filePath) return;
    setLoading(true);
    try {
      const data = await api.getDependencies(filePath, selectedRepo.id, depth);
      setDependencies(data.data);
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">Dependency Analysis</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGetDeps()}
            placeholder="Enter file path (e.g., src/main.py)"
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <input
            type="number"
            min={1}
            max={6}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value || 2))}
            className="w-28 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
          />
          <button 
            onClick={handleGetDeps}
            disabled={loading || !selectedRepo}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Analyze
          </button>
        </div>
      </div>
      
      {dependencies && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2"><Network className="w-5 h-5 text-purple-400" /> Graph</h3>
            <D3ForceGraph
              height={380}
              nodes={dependencies.graph?.nodes || []}
              links={(dependencies.graph?.edges || []).map(e => ({ source: e.source, target: e.target }))}
            />
          </div>

          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Statistics</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-white/60 text-sm">Total Dependencies</p>
                <p className="text-2xl font-bold text-white">{dependencies.statistics?.total_dependencies || 0}</p>
              </div>
              <div>
                <p className="text-white/60 text-sm">Depth Analyzed</p>
                <p className="text-2xl font-bold text-white">{dependencies.statistics?.depth || 0}</p>
              </div>
              <div>
                <p className="text-white/60 text-sm">Circular Dependencies</p>
                <p className="text-2xl font-bold text-red-400">{dependencies.statistics?.circular_dependencies?.length || 0}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Context View (uses CodeBlock)
function ContextView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleGetContext = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.getContext(selectedRepo.id, {
        query,
        max_chunks: 10,
        expand_neighbors: true
      });
      setContext(data.data);
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">Context Retrieval</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGetContext()}
            placeholder="What context do you need?"
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button 
            onClick={handleGetContext}
            disabled={loading || !selectedRepo}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Get Context
          </button>
        </div>
      </div>
      
      {context && (
        <div className="space-y-4">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-2">Summary</h3>
            <p className="text-white/60">Retrieved {context.summary?.total_chunks || 0} relevant code chunks</p>
          </div>
          
          {context.chunks?.map((chunk, idx) => (
            <div key={idx} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-white font-medium">{chunk.file_path}</p>
                  <p className="text-sm text-white/60">Lines {chunk.start_line}-{chunk.end_line} • {chunk.language}</p>
                </div>
                <span className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full text-sm">
                  {chunk.confidence}%
                </span>
              </div>
              <CodeBlock code={chunk.snippet} language={chunk.language || 'plaintext'} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Prompts View
function PromptsView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleBuildPrompt = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.buildPrompt(selectedRepo.id, {
        query,
        options: {
          max_chunks: 12,
          include_dependency_expansion: true
        }
      });
      setPrompt(data.data);
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">Prompt Builder</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleBuildPrompt()}
            placeholder="What do you want to build?"
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button 
            onClick={handleBuildPrompt}
            disabled={loading || !selectedRepo}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Build Prompt
          </button>
        </div>
      </div>
      
      {prompt && (
        <div className="space-y-4">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Token Usage</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-white/60 text-sm">Budget</p>
                <p className="text-xl font-bold text-white">{prompt.token_usage?.budget || 0}</p>
              </div>
              <div>
                <p className="text-white/60 text-sm">Estimated Tokens</p>
                <p className="text-xl font-bold text-white">{prompt.token_usage?.estimated_tokens || 0}</p>
              </div>
              <div>
                <p className="text-white/60 text-sm">Chunks Included</p>
                <p className="text-xl font-bold text-white">{prompt.token_usage?.chunks_included || 0}</p>
              </div>
            </div>
          </div>
          
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Messages ({prompt.messages?.length || 0})</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {prompt.messages?.map((msg, idx) => (
                <div key={idx} className={`p-4 rounded-lg ${
                  msg.role === 'system' ? 'bg-blue-500/10 border border-blue-500/20' :
                  'bg-purple-500/10 border border-purple-500/20'
                }`}>
                  <p className="text-xs font-medium text-white/60 mb-2">{msg.role.toUpperCase()}</p>
                  <p className="text-sm text-white/80 whitespace-pre-wrap">
                    {msg.content.substring(0, 500)}{msg.content.length > 500 ? '...' : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Patches View (uses CodeBlock)
function PatchesView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [patch, setPatch] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  
  const handleGeneratePatch = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.generatePatch(selectedRepo.id, {
        query,
        temperature: 0.2,
        max_output_tokens: 2000
      });
      setPatch(data.data);
    } catch (error) {
      alert('Failed: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  const handleApplyPatch = async () => {
    if (!patch?.patch) return;
    setLoading(true);
    try {
      const data = await api.applyPatch(selectedRepo.id, {
        patch: patch.patch,
        commit_message: `Auto-patch: ${query}`,
        push: false,
        dry_run: false
      });
      setApplyResult(data.data);
      alert('Patch applied successfully!');
    } catch (error) {
      alert('Failed to apply: ' + error.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white mb-4">Patch Generator</h2>
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGeneratePatch()}
            placeholder="Describe the changes you want..."
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button 
            onClick={handleGeneratePatch}
            disabled={loading || !selectedRepo}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Generate Patch
          </button>
        </div>
      </div>
      
      {patch && (
        <div className="space-y-4">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-white">Generated Patch</h3>
              <button 
                onClick={handleApplyPatch}
                disabled={loading}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                Apply Patch
              </button>
            </div>
            
            <div className="mb-4">
              <p className="text-sm text-white/60">
                Validation: <span className={patch.validation?.ok ? 'text-green-400' : 'text-red-400'}>
                  {patch.validation?.ok ? '✓ Valid' : '✗ Issues found'}
                </span>
              </p>
              {patch.validation?.files && (
                <p className="text-sm text-white/60">Files affected: {patch.validation.files.join(', ')}</p>
              )}
            </div>
            
            <CodeBlock code={patch.patch} language="diff" />
          </div>
          
          {applyResult && (
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Application Result</h3>
              <div className="space-y-2 text-sm">
                <p className="text-white/80">Branch: <span className="text-purple-300">{applyResult.new_branch}</span></p>
                <p className="text-white/80">Commit: <span className="text-purple-300">{applyResult.commit}</span></p>
                <p className="text-white/80">Pushed: <span className={applyResult.pushed ? 'text-green-400' : 'text-white/60'}>{applyResult.pushed ? 'Yes' : 'No'}</span></p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Modal Component
function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-white/10 rounded-2xl p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
