import React, { useState, useEffect } from 'react';
import { Users, Zap, ChevronDown } from 'lucide-react';

export const PersonalitySelector = ({ currentPersonalityId, onPersonalityChange }) => {
  const [personalities, setPersonalities] = useState([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    loadPersonalities();
  }, []);

  const loadPersonalities = async () => {
    try {
      const response = await fetch('http://localhost:3020/api/personalities');
      const data = await response.json();
      setPersonalities(data.personalities);
    } catch (error) {
      console.error('Failed to load personalities:', error);
    }
  };

  const currentPersonality = personalities.find(p => p.id === currentPersonalityId);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-colors w-full"
      >
        <Users size={18} />
        <span className="flex-1 text-left text-sm font-medium">
          {currentPersonality?.name || 'Default Assistant'}
        </span>
        <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-full left-0 right-0 mt-2 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 max-h-96 overflow-y-auto">
            {personalities.map((personality) => (
              <button
                key={personality.id}
                onClick={() => {
                  onPersonalityChange(personality.id);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-4 py-3 hover:bg-gray-700 transition-colors border-b border-gray-700 last:border-b-0
                  ${personality.id === currentPersonalityId ? 'bg-gray-700' : ''}`}
              >
                <div className="font-medium text-white mb-1">{personality.name}</div>
                <div className="text-xs text-gray-400 line-clamp-2">{personality.description}</div>
                <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                  <span>Temp: {personality.temperature}</span>
                  {personality.is_builtin && (
                    <span className="px-2 py-0.5 bg-blue-900 text-blue-300 rounded">Built-in</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export const SmartActions = ({ onActionSelect, selectedText }) => {
  const [actions, setActions] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    loadActions();
  }, []);

  const loadActions = async () => {
    try {
      const response = await fetch('http://localhost:3020/api/actions');
      const data = await response.json();
      setActions(data.actions);
    } catch (error) {
      console.error('Failed to load actions:', error);
    }
  };

  const categories = [
    { value: 'all', label: 'All' },
    { value: 'content', label: 'Content' },
    { value: 'workflow', label: 'Workflow' },
    { value: 'analysis', label: 'Analysis' },
    { value: 'code', label: 'Code' }
  ];

  const filteredActions = filter === 'all'
    ? actions
    : actions.filter(a => a.category === filter);

  const handleActionClick = async (action) => {
    // Track usage
    await fetch(`http://localhost:3020/api/actions/${action.id}/use`, {
      method: 'POST'
    });

    // Build prompt from template
    let prompt = action.prompt_template;
    if (selectedText) {
      prompt = prompt.replace('{{selected_text}}', selectedText);
    }
    
    onActionSelect(action, prompt);
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 border-l border-gray-800">
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={20} className="text-yellow-400" />
          <h2 className="text-lg font-semibold text-white">Smart Actions</h2>
        </div>

        {/* Category Filter */}
        <div className="flex gap-1 overflow-x-auto">
          {categories.map(cat => (
            <button
              key={cat.value}
              onClick={() => setFilter(cat.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors
                ${filter === cat.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Actions List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {filteredActions.map((action) => (
          <button
            key={action.id}
            onClick={() => handleActionClick(action)}
            className="w-full text-left p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors group"
          >
            <div className="flex items-start gap-2">
              <span className="text-2xl">{action.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white group-hover:text-blue-400 transition-colors">
                  {action.name}
                </div>
                <div className="text-sm text-gray-400 line-clamp-2 mt-1">
                  {action.description}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded">
                    {action.category}
                  </span>
                  {action.usage_count > 0 && (
                    <span className="text-xs text-gray-500">
                      Used {action.usage_count}x
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        ))}

        {filteredActions.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            No actions in this category
          </div>
        )}
      </div>
    </div>
  );
};

export const PromptAdvisor = ({ conversationId, goal, onSuggestionSelect }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const generateSuggestions = async () => {
    if (!conversationId) return;
    
    setIsLoading(true);
    try {
      const response = await fetch('http://localhost:3020/api/advisor/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          goal,
          message_history: [] // Would need to pass actual history
        })
      });

      const data = await response.json();
      setSuggestions(data.suggestions || []);
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (conversationId && goal) {
      generateSuggestions();
    }
  }, [conversationId, goal]);

  const pathTypeColors = {
    direct: 'bg-green-900 text-green-300',
    thorough: 'bg-blue-900 text-blue-300',
    alternative: 'bg-purple-900 text-purple-300',
    validate: 'bg-yellow-900 text-yellow-300'
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-800">
        <h3 className="font-semibold text-white">Suggested Next Steps</h3>
        <button
          onClick={generateSuggestions}
          disabled={isLoading}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm text-white transition-colors"
        >
          {isLoading ? 'Generating...' : 'Refresh'}
        </button>
      </div>

      {/* Suggestions */}
      <div className="p-4 space-y-3">
        {suggestions.length > 0 ? (
          suggestions.map((suggestion, index) => (
            <button
              key={index}
              onClick={() => onSuggestionSelect(suggestion)}
              className="w-full text-left p-4 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700 hover:border-blue-600"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="font-medium text-white">{suggestion.title}</div>
                <span className={`text-xs px-2 py-1 rounded ${pathTypeColors[suggestion.path_type] || 'bg-gray-700 text-gray-300'}`}>
                  {suggestion.path_type}
                </span>
              </div>
              <div className="text-sm text-gray-400 mb-3">
                {suggestion.rationale}
              </div>
              <div className="text-sm text-blue-400 mb-2 font-mono bg-gray-900 p-2 rounded">
                "{suggestion.prompt}"
              </div>
              <div className="text-xs text-gray-500">
                Est. {suggestion.estimated_exchanges} exchanges
              </div>
            </button>
          ))
        ) : (
          <div className="text-center text-gray-500 py-8">
            {isLoading ? 'Generating suggestions...' : 'No suggestions yet'}
          </div>
        )}
      </div>
    </div>
  );
};
