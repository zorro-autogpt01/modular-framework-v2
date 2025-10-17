import type React from 'react'
import { Card } from '../shared/Card'
import { Badge } from '../shared/Badge'
import { Button } from '../shared/Button'
import { Lightbulb, TrendingUp, Clock, Users } from 'lucide-react'
import type { FeatureSuggestion } from '../../types/index'

interface SuggestionCardProps {
  suggestion: FeatureSuggestion
  onStatusChange?: (status: string) => void
  onViewDetails?: () => void
}

export const SuggestionCard: React.FC<SuggestionCardProps> = ({ 
  suggestion, 
  onStatusChange,
  onViewDetails 
}) => {
  const getPriorityVariant = (priority: string) => {
    switch (priority) {
      case 'critical': return 'danger'
      case 'high': return 'warning'
      case 'medium': return 'info'
      case 'low': return 'default'
      default: return 'default'
    }
  }

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'approved': return 'success'
      case 'in_progress': return 'info'
      case 'completed': return 'success'
      case 'rejected': return 'danger'
      default: return 'default'
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-yellow-100 rounded-lg">
            <Lightbulb className="w-5 h-5 text-yellow-700" />
          </div>
          <div className="flex-1">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{suggestion.title}</h3>
                <p className="mt-1 text-sm text-gray-600">{suggestion.description}</p>
              </div>
              <Badge variant={getStatusVariant(suggestion.status)}>
                {suggestion.status}
              </Badge>
            </div>
          </div>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-gray-600">
            <TrendingUp className="w-4 h-4" />
            <span className="font-medium">Rationale:</span>
            <span>{suggestion.rationale}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant={getPriorityVariant(suggestion.priority)}>
            {suggestion.priority} priority
          </Badge>
          <Badge>
            <Clock className="w-3 h-3 mr-1" />
            {suggestion.effort_estimate} effort
          </Badge>
          <Badge>
            <Users className="w-3 h-3 mr-1" />
            {suggestion.proposed_by}
          </Badge>
        </div>

        {suggestion.status === 'proposed' && onStatusChange && (
          <div className="flex items-center gap-2 pt-3 border-t border-gray-200">
            <Button size="sm" onClick={() => onStatusChange('approved')}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onStatusChange('in_progress')}>
              Start Work
            </Button>
            <Button size="sm" variant="danger" onClick={() => onStatusChange('rejected')}>
              Reject
            </Button>
            {onViewDetails && (
              <Button size="sm" variant="ghost" onClick={onViewDetails} className="ml-auto">
                View Details
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}