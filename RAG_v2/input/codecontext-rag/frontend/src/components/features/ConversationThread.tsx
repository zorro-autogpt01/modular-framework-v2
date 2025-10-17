import type React from 'react'
import { Card } from '../shared/Card'
import type { ConversationMessage } from '../../types/index'

interface ConversationThreadProps {
  messages: ConversationMessage[]
}

export const ConversationThread: React.FC<ConversationThreadProps> = ({ messages }) => {
  const getAgentIcon = (role: string) => {
    if (role === 'Product Manager') return '🎯'
    if (role === 'Growth Marketer') return '📈'
    return '🤖'
  }

  return (
    <Card title="Agent Discussion">
      <div className="space-y-4">
        {messages.map((message) => (
          <div key={message.id} className="flex gap-3">
            <div className="flex-shrink-0">
              <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                <span className="text-lg">{getAgentIcon(message.agent_role)}</span>
              </div>
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{message.agent_role}</span>
                <span className="text-xs text-gray-500">
                  {new Date(message.created_at).toLocaleString()}
                </span>
              </div>
              <div className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                {message.message}
              </div>
              {message.reasoning && (
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer hover:text-gray-700">
                    View reasoning
                  </summary>
                  <div className="mt-2 p-2 bg-gray-100 rounded">
                    {message.reasoning}
                  </div>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}