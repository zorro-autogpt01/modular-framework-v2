import React, { createContext, useContext, useState, useEffect } from 'react'
import type { Repository } from '../types/index'

interface AppContextType {
  selectedRepo: Repository | null
  setSelectedRepo: (repo: Repository | null) => void
  theme: 'light' | 'dark'
  toggleTheme: () => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    // Load theme from localStorage
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null
    if (savedTheme) {
      setTheme(savedTheme)
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
  }

  return (
    <AppContext.Provider value={{ selectedRepo, setSelectedRepo, theme, toggleTheme }}>
      {children}
    </AppContext.Provider>
  )
}

export const useApp = () => {
  const context = useContext(AppContext)
  if (context === undefined) {
    throw new Error('useApp must be used within AppProvider')
  }
  return context
}