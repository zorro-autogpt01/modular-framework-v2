import type React from 'react'
import { useLocation } from 'react-router-dom'
import { Bell, Settings } from 'lucide-react'

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/repositories': 'Repositories',
  '/search': 'Code Search',
  '/recommendations': 'File Recommendations',
  '/dependencies': 'Dependency Analysis',
  '/graphs': 'Code Graphs',
  '/context': 'Context Retrieval',
  '/prompts': 'Prompt Builder',
  '/patches': 'Patch Generator',
  '/features': 'Product Features',
  '/product-analysis': 'Product Analysis',
  '/impact': 'Impact Analysis',
  '/tests': 'Test Management',
}

export const Header: React.FC = () => {
  const location = useLocation()
  const title = pageTitles[location.pathname] || 'CodeContext RAG'

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">{title}</h2>
        
        <div className="flex items-center gap-4">
          <button className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            <Bell className="w-5 h-5" />
          </button>
          <button className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  )
}