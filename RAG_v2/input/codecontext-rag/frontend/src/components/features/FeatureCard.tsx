import type React from 'react'
import { Card } from '../shared/Card'
import { Badge } from '../shared/Badge'
import { Code, Globe, Box } from 'lucide-react'
import type { Feature } from '../../types/index'

interface FeatureCardProps {
  feature: Feature
  onClick?: () => void
}

export const FeatureCard: React.FC<FeatureCardProps> = ({ feature, onClick }) => {
  const getMaturityVariant = (maturity: string) => {
    switch (maturity) {
      case 'production': return 'success'
      case 'beta': return 'warning'
      case 'prototype': return 'info'
      default: return 'default'
    }
  }

  return (
    <div 
        className="cursor-pointer hover:shadow-lg transition-shadow"
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
        <Card>
            <div className="space-y-3">
                <div className="flex items-start justify-between">
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900">{feature.name}</h3>
                    <p className="mt-1 text-sm text-gray-600">{feature.description}</p>
                </div>
                <Badge variant={getMaturityVariant(feature.maturity)}>
                    {feature.maturity}
                </Badge>
                </div>

                <div className="flex items-center gap-4 text-sm text-gray-500">
                <div className="flex items-center gap-1">
                    <Code className="w-4 h-4" />
                    <span>{feature.code_files.length} files</span>
                </div>
                {feature.api_endpoints.length > 0 && (
                    <div className="flex items-center gap-1">
                    <Globe className="w-4 h-4" />
                    <span>{feature.api_endpoints.length} endpoints</span>
                    </div>
                )}
                {feature.ui_components.length > 0 && (
                    <div className="flex items-center gap-1">
                    <Box className="w-4 h-4" />
                    <span>{feature.ui_components.length} components</span>
                    </div>
                )}
                </div>

                <div className="pt-3 border-t border-gray-200">
                <div className="flex items-center justify-between">
                    <Badge>{feature.category}</Badge>
                    <div className="text-sm text-gray-500">
                    Confidence: <span className="font-medium text-gray-900">{Math.round(feature.confidence * 100)}%</span>
                    </div>
                </div>
                </div>
            </div>
        </Card>
    </div>
  )
}