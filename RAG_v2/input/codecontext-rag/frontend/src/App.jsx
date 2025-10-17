import React, { useState, useEffect } from 'react';
import { Search, GitBranch, FileCode, Zap, TrendingUp, Settings, Plus, Trash2, RefreshCw, Code, GitPullRequest, Network, Activity, MessageSquare, Layers, Beaker, Map } from 'lucide-react';
import mermaid from 'mermaid';

// API Client
const API_BASE = 'http://localhost:7998';

const api = {
  async request(endpoint, options = {}) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
    return response.json();
  },
  listRepos: () => api.request('/repositories'),
  addRepo: (data) => api.request('/repositories', { method: 'POST', body: JSON.stringify(data) }),
  deleteRepo: (id) => api.request(`/repositories/${id}`, { method: 'DELETE' }),
  reindexRepo: (id) => api.request(`/repositories/${id}/reindex`, { method: 'POST' }),
  getIndexStatus: (id) => api.request(`/repositories/${id}/index/status`),
  getRecommendations: (data) => api.request('/recommendations', { method: 'POST', body: JSON.stringify(data) }),
  interactiveRecommendations: (data) => api.request('/recommendations/interactive', { method: 'POST', body: JSON.stringify(data) }),
  refineRecommendations: (data) => api.request('/recommendations/refine', { method: 'POST', body: JSON.stringify(data) }),
  getDependencies: (filePath, repoId, depth = 2, format = 'json') => api.request(`/dependencies/${encodeURIComponent(filePath)}?repository_id=${repoId}&depth=${depth}&direction=both&format=${format}`),
  getGraph: (repoId, type = 'dependency', format = 'json', node = '', depth = 0) => api.request(`/repositories/${repoId}/graphs?type=${type}&format=${format}${node ? `&node_filter=${encodeURIComponent(node)}` : ''}${depth ? `&depth=${depth}` : ''}`),
  getContext: (repoId, data) => api.request(`/repositories/${repoId}/context`, { method: 'POST', body: JSON.stringify(data) }),
  buildPrompt: (repoId, data) => api.request(`/repositories/${repoId}/prompt`, { method: 'POST', body: JSON.stringify(data) }),
  generatePatch: (repoId, data) => api.request(`/repositories/${repoId}/patch`, { method: 'POST', body: JSON.stringify(data) }),
  applyPatch: (repoId, data) => api.request(`/repositories/${repoId}/apply-patch`, { method: 'POST', body: JSON.stringify(data) }),
  searchCode: (data) => api.request('/search/code', { method: 'POST', body: JSON.stringify(data) }),
  selectTests: (repoId, data) => api.request(`/repositories/${repoId}/tests/select`, { method: 'POST', body: JSON.stringify(data) }),
  runTests: (repoId, data) => api.request(`/repositories/${repoId}/tests/run`, { method: 'POST', body: JSON.stringify(data) }),
};

mermaid.initialize({ startOnLoad: false, theme: 'dark' });

function MermaidRenderer({ chart, className }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    if (!chart) { setSvg(''); return; }
    mermaid.render(id, chart).then(({ svg }) => { if (!cancelled) setSvg(svg); }).catch(() => setSvg(''));
    return () => { cancelled = true; };
  }, [chart]);
  if (!chart) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('repositories');
  const [repos, setRepos] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { loadRepos(); }, []);
  const loadRepos = async () => {
    setLoading(true);
    try {
      const data = await api.listRepos();
      setRepos(data);
      if (data.length > 0 && !selectedRepo) setSelectedRepo(data[0]);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
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
            <select className="px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm" value={selectedRepo?.id || ''} onChange={(e) => setSelectedRepo(repos.find(r => r.id === e.target.value))}>
              <option value="">Select Repository</option>
              {repos.map(repo => (<option key={repo.id} value={repo.id}>{repo.full_name}</option>))}
            </select>
          </div>
        </div>
      </header>
      <nav className="border-b border-white/10 bg-black/10 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1 overflow-x-auto">
            <NavTab icon={Layers} label="Repositories" active={activeTab === 'repositories'} onClick={() => setActiveTab('repositories')} />
            <NavTab icon={Search} label="Search" active={activeTab === 'search'} onClick={() => setActiveTab('search')} />
            <NavTab icon={TrendingUp} label="Recommendations" active={activeTab === 'recommendations'} onClick={() => setActiveTab('recommendations')} />
            <NavTab icon={Network} label="Dependencies" active={activeTab === 'dependencies'} onClick={() => setActiveTab('dependencies')} />
            <NavTab icon={Map} label="Graphs" active={activeTab === 'graphs'} onClick={() => setActiveTab('graphs')} />
            <NavTab icon={FileCode} label="Context" active={activeTab === 'context'} onClick={() => setActiveTab('context')} />
            <NavTab icon={MessageSquare} label="Prompts" active={activeTab === 'prompts'} onClick={() => setActiveTab('prompts')} />
            <NavTab icon={Beaker} label="Tests" active={activeTab === 'tests'} onClick={() => setActiveTab('tests')} />
            <NavTab icon={GitPullRequest} label="Patches" active={activeTab === 'patches'} onClick={() => setActiveTab('patches')} />
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'repositories' && <RepositoriesView repos={repos} onReload={loadRepos} />}
        {activeTab === 'search' && <SearchView selectedRepo={selectedRepo} />}
        {activeTab === 'recommendations' && <RecommendationsView selectedRepo={selectedRepo} />}
        {activeTab === 'dependencies' && <DependenciesView selectedRepo={selectedRepo} />}
        {activeTab === 'graphs' && <GraphExplorerView selectedRepo={selectedRepo} />}
        {activeTab === 'context' && <ContextView selectedRepo={selectedRepo} />}
        {activeTab === 'prompts' && <PromptsView selectedRepo={selectedRepo} />}
        {activeTab === 'tests' && <TestsView selectedRepo={selectedRepo} />}
        {activeTab === 'patches' && <PatchesView selectedRepo={selectedRepo} />}
      </main>
    </div>
  );
}

function NavTab({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${active ? 'text-purple-300 border-purple-400' : 'text-white/60 border-transparent hover:text-white/80'}`}>
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}


// Repositories View
function RepositoriesView({ repos, onReload }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({ connection_id: '', branch: '', auto_index: true });
  
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
        {repos.map(repo => (
          <div key={repo.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6 hover:bg-white/10 transition-all">
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <GitBranch className="w-5 h-5 text-purple-400" />
                  <h3 className="text-lg font-semibold text-white">{repo.full_name}</h3>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    repo.status === 'indexed' ? 'bg-green-500/20 text-green-300' :
                    repo.status === 'indexing' ? 'bg-yellow-500/20 text-yellow-300' :
                    repo.status === 'error' ? 'bg-red-500/20 text-red-300' :
                    'bg-gray-500/20 text-gray-300'
                  }`}>
                    {repo.status}
                  </span>
                </div>
                <div className="text-sm text-white/60 space-y-1">
                  <p>Branch: <span className="text-white/80">{repo.branch}</span></p>
                  {repo.indexed_at && <p>Last indexed: <span className="text-white/80">{new Date(repo.indexed_at).toLocaleString()}</span></p>}
                </div>
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
        ))}
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

// Search View
function SearchView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const handleSearch = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.searchCode({
        repository_id: selectedRepo.id,
        query,
        search_type: 'semantic',
        max_results: 20
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
        <div className="flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search for code patterns, functions, or features..."
            className="flex-1 px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
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
              <pre className="bg-black/30 p-4 rounded-lg text-sm text-white/80 overflow-x-auto">
                <code>{result.code_snippet}</code>
              </pre>
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
              onKeyPress={(e) => e.key === 'Enter' && handleGetRecommendations()}
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

// Dependencies View
function DependenciesView({ selectedRepo }) {
  const [filePath, setFilePath] = useState('');
  const [dependencies, setDependencies] = useState(null);
  const [mermaidText, setMermaidText] = useState('');
  const [loading, setLoading] = useState(false);
  
  const handleGetDeps = async (format = 'json') => {
    if (!selectedRepo || !filePath) return;
    setLoading(true);
    try {
      const data = await api.getDependencies(filePath, selectedRepo.id, 2, format);
      if (format === 'json') {
        setDependencies(data.data);
        setMermaidText('');
      } else {
        setDependencies(null);
        setMermaidText(data.data?.graph_text || '');
      }
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
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleGetDeps('json')}
            placeholder="Enter file path (e.g., src/main.py)"
            className="flex-1 min-w-[280px] px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button 
            onClick={() => handleGetDeps('json')}
            disabled={loading || !selectedRepo}
            className="px-4 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Analyze (JSON)
          </button>
          <button 
            onClick={() => handleGetDeps('mermaid')}
            disabled={loading || !selectedRepo}
            className="px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Mermaid
          </button>
          <button 
            onClick={() => handleGetDeps('plantuml')}
            disabled={loading || !selectedRepo}
            className="px-4 py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            PlantUML
          </button>
        </div>
      </div>
      
      {dependencies && (
        <div className="grid md:grid-cols-2 gap-6">
          <DependencyGraph 
            title="Imports" 
            files={dependencies.graph?.nodes?.filter(n => n.type === 'import') || []}
            edges={dependencies.graph?.edges || []}
          />
          <DependencyGraph 
            title="Imported By" 
            files={dependencies.graph?.nodes?.filter(n => n.type === 'imported_by') || []}
            edges={dependencies.graph?.edges || []}
          />
          
          <div className="md:col-span-2 bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
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

      {mermaidText && (
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Mermaid Diagram</h3>
          <MermaidRenderer chart={mermaidText} />
        </div>
      )}
    </div>
  );
}

function DependencyGraph({ title, files, edges }) {
  return (
    <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Network className="w-5 h-5 text-purple-400" />
        {title}
      </h3>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {files.map((file, idx) => (
          <div key={idx} className="flex items-center gap-3 p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-all">
            <FileCode className="w-4 h-4 text-purple-400" />
            <span className="text-white/80 text-sm">{file.label}</span>
          </div>
        ))}
        {files.length === 0 && (
          <p className="text-white/40 text-sm text-center py-8">No dependencies found</p>
        )}
      </div>
    </div>
  );
}

// Context View
function ContextView({ selectedRepo }) {
  const [query, setQuery] = useState('');
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [retrievalMode, setRetrievalMode] = useState('vector');
  const [callDepth, setCallDepth] = useState(2);
  
  const handleGetContext = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.getContext(selectedRepo.id, {
        query,
        max_chunks: 10,
        expand_neighbors: true,
        retrieval_mode: retrievalMode,
        call_graph_depth: Number(callDepth) || 2
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
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleGetContext()}
            placeholder="What context do you need?"
            className="flex-1 min-w-[280px] px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <select
            value={retrievalMode}
            onChange={(e) => setRetrievalMode(e.target.value)}
            className="px-3 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
          >
            <option value="vector">Vector</option>
            <option value="callgraph">Call Graph</option>
          </select>
          <input
            type="number"
            min={1}
            max={5}
            value={callDepth}
            onChange={(e) => setCallDepth(e.target.value)}
            className="w-24 px-3 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
            title="Call graph depth"
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
            <p className="text-white/60">
              Retrieved {context.summary?.total_chunks || 0} chunks • Mode: {context.summary?.retrieval_mode || 'vector'}
            </p>
          </div>

          {Array.isArray(context.artifacts) && context.artifacts.length > 0 && (
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Artifacts</h3>
              {context.artifacts.map((a, idx) => (
                <div key={idx} className="mb-4">
                  <p className="text-sm text-white/60 mb-2">{a.label} ({a.type})</p>
                  {a.type === 'mermaid' ? (
                    <MermaidRenderer chart={a.content} />
                  ) : (
                    <pre className="bg-black/30 p-3 rounded text-white/70 overflow-x-auto">
                      <code>{a.content}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          
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
              <pre className="bg-black/30 p-4 rounded-lg text-sm text-white/80 overflow-x-auto">
                <code>{chunk.snippet}</code>
              </pre>
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
  const [retrievalMode, setRetrievalMode] = useState('vector');
  const [callDepth, setCallDepth] = useState(2);
  
  const handleBuildPrompt = async () => {
    if (!selectedRepo || !query) return;
    setLoading(true);
    try {
      const data = await api.buildPrompt(selectedRepo.id, {
        query,
        options: {
          max_chunks: 12,
          include_dependency_expansion: true,
          retrieval_mode: retrievalMode,
          call_graph_depth: Number(callDepth) || 2
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
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleBuildPrompt()}
            placeholder="What do you want to build?"
            className="flex-1 min-w-[280px] px-4 py-3 bg-white/5 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <select
            value={retrievalMode}
            onChange={(e) => setRetrievalMode(e.target.value)}
            className="px-3 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
          >
            <option value="vector">Vector</option>
            <option value="callgraph">Call Graph</option>
          </select>
          <input
            type="number"
            min={1}
            max={5}
            value={callDepth}
            onChange={(e) => setCallDepth(e.target.value)}
            className="w-24 px-3 py-3 bg-white/5 border border-white/20 rounded-lg text-white"
            title="Call graph depth"
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

          {Array.isArray(prompt.artifacts) && prompt.artifacts.length > 0 && (
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Artifacts</h3>
              {prompt.artifacts.map((a, idx) => (
                <div key={idx} className="mb-4">
                  <p className="text-sm text-white/60 mb-2">{a.label} ({a.type})</p>
                  {a.type === 'mermaid' ? (
                    <MermaidRenderer chart={a.content} />
                  ) : (
                    <pre className="bg-black/30 p-3 rounded text-white/70 overflow-x-auto">
                      <code>{a.content}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Messages ({prompt.messages?.length || 0})</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {prompt.messages?.map((msg, idx) => (
                <div key={idx} className={`p-4 rounded-lg ${
                  msg.role === 'system' ? 'bg-blue-500/10 border border-blue-500/20' :
                  'bg-purple-500/10 border border-purple-500/20'
                }`}>
                  <p className="text-xs font-medium text-white/60 mb-2">{msg.role.toUpperCase()}</p>
                  <p className="text-sm text-white/80 whitespace-pre-wrap">{msg.content.substring(0, 500)}{msg.content.length > 500 ? '...' : ''}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Patches View
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
            onKeyPress={(e) => e.key === 'Enter' && handleGeneratePatch()}
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
            
            <pre className="bg-black/30 p-4 rounded-lg text-sm text-green-400 overflow-x-auto max-h-96">
              <code>{patch.patch}</code>
            </pre>
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

function GraphExplorerView({ selectedRepo }) {
  const [type, setType] = useState('dependency');
  const [format, setFormat] = useState('mermaid');
  const [node, setNode] = useState('');
  const [depth, setDepth] = useState(2);
  const [result, setResult] = useState(null);
  const [chart, setChart] = useState('');
  const run = async () => {
    if (!selectedRepo) return;
    try {
      const data = await api.getGraph(selectedRepo.id, type, format, node, depth);
      setResult(data.data);
      if (format === 'mermaid') setChart(data.data?.graph_text || '');
      else setChart('');
    } catch (e) { alert('Failed: ' + e.message); }
  };
  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <select value={type} onChange={e => setType(e.target.value)} className="px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white">
          <option value="dependency">dependency</option>
          <option value="module">module</option>
          <option value="class">class</option>
          <option value="call">call</option>
        </select>
        <select value={format} onChange={e => setFormat(e.target.value)} className="px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white">
          <option value="mermaid">mermaid</option>
          <option value="json">json</option>
          <option value="plantuml">plantuml</option>
        </select>
        <input placeholder="node filter (optional)" value={node} onChange={e => setNode(e.target.value)} className="px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white flex-1 min-w-[200px]" />
        <input type="number" min={0} max={5} value={depth} onChange={e => setDepth(Number(e.target.value))} className="w-24 px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white" />
        <button onClick={run} disabled={!selectedRepo} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg">Fetch</button>
      </div>
      {chart && <MermaidRenderer chart={chart} />}
      {result && format !== 'mermaid' && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          <pre className="text-white/80 text-sm overflow-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function TestsView({ selectedRepo }) {
  const [modified, setModified] = useState('src/auth/login.py\nsrc/api/routes/users.py');
  const [ranked, setRanked] = useState(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const selectTests = async () => {
    if (!selectedRepo) return;
    try {
      const files = modified.split(/\n|,/).map(s => s.trim()).filter(Boolean);
      const data = await api.selectTests(selectedRepo.id, { modified_files: files });
      setRanked(data.data);
    } catch (e) { alert('Failed: ' + e.message); }
  };
  const runSelected = async () => {
    if (!selectedRepo) return;
    setRunning(true);
    try {
      const tests = (ranked?.ranked_tests || []).filter(t => t.score > 0).slice(0, 10).map(t => t.test);
      const data = await api.runTests(selectedRepo.id, { tests });
      setOutput(data.data?.output || '');
    } catch (e) { alert('Run failed: ' + e.message); } finally { setRunning(false); }
  };
  return (
    <div className="space-y-6">
      <div className="bg-white/5 border border-white/10 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-white mb-3">Select Tests</h3>
        <textarea className="w-full min-h-[120px] px-3 py-2 bg-white/5 border border-white/20 rounded-lg text-white" value={modified} onChange={e => setModified(e.target.value)} />
        <div className="mt-3 flex gap-3">
          <button onClick={selectTests} disabled={!selectedRepo} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg">Select</button>
          <button onClick={runSelected} disabled={!selectedRepo || running} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg">{running ? 'Running...' : 'Run Selected'}</button>
        </div>
      </div>
      {ranked && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <h4 className="text-white font-semibold mb-3">Ranked Tests</h4>
          <ul className="text-white/80 text-sm space-y-1">
            {(ranked.ranked_tests || []).slice(0, 20).map((t, i) => (<li key={i}>{t.test} — score {t.score}</li>))}
          </ul>
        </div>
      )}
      {output && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <h4 className="text-white font-semibold mb-3">Test Output</h4>
          <pre className="text-white/80 text-sm overflow-auto whitespace-pre-wrap">{output}</pre>
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