import type React from 'react'
import { NavLink } from 'react-router-dom'
import {
  Code2,
  Database,
  Search,
  TrendingUp,
  Network,
  Map,
  FileCode,
  MessageSquare,
  GitPullRequest,
  Sparkles,
  LineChart,
  Beaker,
  Activity
} from 'lucide-react'
import clsx from 'clsx'

const navItems = [
  { path: '/', icon: Activity, label: 'Dashboard' },
  { path: '/repositories', icon: Database, label: 'Repositories' },
  { path: '/search', icon: Search, label: 'Code Search' },
  { path: '/recommendations', icon: TrendingUp, label: 'Recommendations' },
  { path: '/dependencies', icon: Network, label: 'Dependencies' },
  { path: '/graphs', icon: Map, label: 'Graphs' },
  { path: '/context', icon: FileCode, label: 'Context' },
  { path: '/prompts', icon: MessageSquare, label: 'Prompts' },
  { path: '/patches', icon: GitPullRequest, label: 'Patches' },
  { path: '/features', icon: Sparkles, label: 'Features' },
  { path: '/product-analysis', icon: LineChart, label: 'Product Analysis' },
  { path: '/impact', icon: Activity, label: 'Impact Analysis' },
  { path: '/tests', icon: Beaker, label: 'Tests' },
]

export const Sidebar: React.FC = () => {
  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center">
            <Code2 className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">CodeContext</h1>
            <p className="text-xs text-gray-500">Intelligent RAG</p>
          </div>
        </div>
      </div>
      
      <nav className="flex-1 overflow-y-auto p-4">
        <div className="space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-gray-700 hover:bg-gray-100'
                )
              }
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
      
      <div className="p-4 border-t border-gray-200">
        <div className="text-xs text-gray-500">
          <p>Version 2.0.0</p>
          <p className="mt-1">API Status: <span className="text-green-600">●</span> Online</p>
        </div>
      </div>
    </aside>
  )
}