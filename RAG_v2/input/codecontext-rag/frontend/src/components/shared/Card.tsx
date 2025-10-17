import type React from 'react'
import clsx from 'clsx'

interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string
  actions?: React.ReactNode
}

export const Card: React.FC<CardProps> = ({ children, className, title, actions }) => {
  return (
    <div className={clsx('bg-white rounded-lg shadow-md border border-gray-200', className)}>
      {(title || actions) && (
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  )
}