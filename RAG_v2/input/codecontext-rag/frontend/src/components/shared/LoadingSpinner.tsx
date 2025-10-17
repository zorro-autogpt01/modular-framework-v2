import type React from 'react'
import { Loader2 } from 'lucide-react'

interface LoadingSpinnerProps {
  text?: string
}

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ text = 'Loading...' }) => {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="w-8 h-8 text-primary-600 animate-spin mb-4" />
      <p className="text-gray-600">{text}</p>
    </div>
  )
}