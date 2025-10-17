import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../components/shared/Card'
import { Badge } from '../components/shared/Badge'
import { LoadingSpinner } from '../components/shared/LoadingSpinner'
import { api } from '../services/api'
import { 
  Database, 
  TrendingUp, 
  Sparkles, 
  Activity,
  GitBranch,
  Code,
  BarChart3
} from 'lucide-react'

interface DashboardStats {
  total_repos: number
  indexed_repos: number
  total_features: number
  pending_suggestions: number
  recent_activity: any[]
}

export const Dashboard: React.FC = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<DashboardStats | null>(null)

  useEffect(() => {
    loadDashboard()
  }, [])

  const loadDashboard = async () => {
    try {
      setLoading(true)
      // Load repositories
      const repos = await api.listRepositories()
      
      // Aggregate stats
      const dashboardStats: DashboardStats = {
        total_repos: repos.length || 0,
        indexed_repos: repos.filter((r: any) => r.status === 'indexed').length || 0,
        total_features: 0,
        pending_suggestions: 0,
        recent_activity: []
      }

      // Load features for first repo if available
      if (repos.length > 0) {
        try {
          const features = await api.listFeatures(repos[0].id)
          dashboardStats.total_features = features.total_features || 0
        } catch (err) {
          console.error('Failed to load features:', err)
        }

        try {
          const suggestions = await api.listSuggestions(repos[0].id)
          dashboardStats.pending_suggestions = 
            suggestions.suggestions?.filter((s: any) => s.status === 'proposed').length || 0
        } catch (err) {
          console.error('Failed to load suggestions:', err)
        }
      }

      setStats(dashboardStats)
    } catch (error) {
      console.error('Failed to load dashboard:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <LoadingSpinner text="Loading dashboard..." />
  }

  const statCards = [
    {
      title: 'Repositories',
      value: stats?.total_repos || 0,
      subtitle: `${stats?.indexed_repos || 0} indexed`,
      icon: Database,
      color: 'bg-blue-500',
      onClick: () => navigate('/repositories')
    },
    {
      title: 'Features',
      value: stats?.total_features || 0,
      subtitle: 'Extracted from code',
      icon: Sparkles,
      color: 'bg-purple-500',
      onClick: () => navigate('/features')
    },
    {
      title: 'Suggestions',
      value: stats?.pending_suggestions || 0,
      subtitle: 'Pending review',
      icon: TrendingUp,
      color: 'bg-green-500',
      onClick: () => navigate('/product-analysis')
    },
    {
      title: 'Activity',
      value: '24h',
      subtitle: 'Last analysis',
      icon: Activity,
      color: 'bg-orange-500',
      onClick: () => navigate('/product-analysis')
    }
  ]

  return (
    <div className="space-y-6">
      {/* Welcome Section */}
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Welcome to CodeContext RAG</h2>
            <p className="mt-2 text-gray-600">
              Intelligent code analysis and product insights powered by AI
            </p>
          </div>
          <Badge variant="success">All Systems Operational</Badge>
        </div>
      </Card>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat) => (
          <Card 
            key={stat.title}
            className="cursor-pointer hover:shadow-lg transition-all"
            onClick={stat.onClick}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">{stat.title}</p>
                <p className="mt-2 text-3xl font-bold text-gray-900">{stat.value}</p>
                <p className="mt-1 text-sm text-gray-500">{stat.subtitle}</p>
              </div>
              <div className={`p-3 rounded-lg ${stat.color}`}>
                <stat.icon className="w-6 h-6 text-white" />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Quick Actions">
          <div className="space-y-3">
            <button
              onClick={() => navigate('/repositories')}
              className="w-full flex items-center gap-3 p-3 text-left bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <GitBranch className="w-5 h-5 text-primary-600" />
              <div>
                <p className="font-medium text-gray-900">Add Repository</p>
                <p className="text-sm text-gray-600">Connect a new codebase</p>
              </div>
            </button>
            
            <button
              onClick={() => navigate('/search')}
              className="w-full flex items-center gap-3 p-3 text-left bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Code className="w-5 h-5 text-primary-600" />
              <div>
                <p className="font-medium text-gray-900">Search Code</p>
                <p className="text-sm text-gray-600">Find similar patterns</p>
              </div>
            </button>
            
            <button
              onClick={() => navigate('/product-analysis')}
              className="w-full flex items-center gap-3 p-3 text-left bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <BarChart3 className="w-5 h-5 text-primary-600" />
              <div>
                <p className="font-medium text-gray-900">Product Analysis</p>
                <p className="text-sm text-gray-600">Run AI analysis</p>
              </div>
            </button>
          </div>
        </Card>

        <Card title="System Capabilities">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between p-2 bg-green-50 rounded">
              <span className="text-gray-700">Code Parsing</span>
              <Badge variant="success">Active</Badge>
            </div>
            <div className="flex items-center justify-between p-2 bg-green-50 rounded">
              <span className="text-gray-700">Vector Search</span>
              <Badge variant="success">Active</Badge>
            </div>
            <div className="flex items-center justify-between p-2 bg-green-50 rounded">
              <span className="text-gray-700">LLM Gateway</span>
              <Badge variant="success">Connected</Badge>
            </div>
            <div className="flex items-center justify-between p-2 bg-green-50 rounded">
              <span className="text-gray-700">Feature Extraction</span>
              <Badge variant="success">Enabled</Badge>
            </div>
            <div className="flex items-center justify-between p-2 bg-green-50 rounded">
              <span className="text-gray-700">Multi-Agent System</span>
              <Badge variant="success">Ready</Badge>
            </div>
          </div>
        </Card>
      </div>

      {/* Getting Started Guide */}
      <Card title="Getting Started">
        <div className="prose prose-sm max-w-none">
          <ol className="space-y-2">
            <li>
              <strong>Connect a repository</strong> - Add your codebase via GitHub Hub integration
            </li>
            <li>
              <strong>Index the code</strong> - Let the system analyze structure, dependencies, and patterns
            </li>
            <li>
              <strong>Extract features</strong> - AI identifies product features from your code
            </li>
            <li>
              <strong>Run product analysis</strong> - PM and Marketer agents suggest enhancements
            </li>
            <li>
              <strong>Generate code</strong> - Use context-aware prompts to build features
            </li>
          </ol>
        </div>
      </Card>
    </div>
  )
}