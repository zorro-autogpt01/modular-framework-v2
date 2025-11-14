import React, { useState, useEffect } from 'react';
import { Target, Edit2, Check, X, Plus, Trash2 } from 'lucide-react';

export const GoalPanel = ({ conversationId, onGoalUpdate }) => {
  const [goal, setGoal] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editGoal, setEditGoal] = useState({
    goal_text: '',
    goal_type: 'create_deliverable',
    success_criteria: [],
    constraints: [],
    progress: 0
  });
  const [newCriteria, setNewCriteria] = useState('');
  const [newConstraint, setNewConstraint] = useState('');

  useEffect(() => {
    if (conversationId) {
      loadGoal();
    }
  }, [conversationId]);

  const loadGoal = async () => {
    try {
      const response = await fetch(`http://localhost:3020/api/conversations/${conversationId}/goal`);
      const data = await response.json();
      if (data.goal) {
        setGoal(data.goal);
        setEditGoal({
          goal_text: data.goal.goal_text || '',
          goal_type: data.goal.goal_type || 'create_deliverable',
          success_criteria: data.goal.success_criteria || [],
          constraints: data.goal.constraints || [],
          progress: data.goal.progress || 0
        });
      }
    } catch (error) {
      console.error('Failed to load goal:', error);
    }
  };

  const handleSave = async () => {
    try {
      const url = goal
        ? `http://localhost:3020/api/goals/${goal.id}`
        : `http://localhost:3020/api/conversations/${conversationId}/goal`;
      
      const method = goal ? 'PUT' : 'POST';

      await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editGoal)
      });

      await loadGoal();
      setIsEditing(false);
      onGoalUpdate?.();
    } catch (error) {
      console.error('Failed to save goal:', error);
    }
  };

  const handleAddCriteria = () => {
    if (!newCriteria.trim()) return;
    setEditGoal(prev => ({
      ...prev,
      success_criteria: [...(prev.success_criteria || []), { text: newCriteria, checked: false }]
    }));
    setNewCriteria('');
  };

  const handleAddConstraint = () => {
    if (!newConstraint.trim()) return;
    setEditGoal(prev => ({
      ...prev,
      constraints: [...(prev.constraints || []), newConstraint]
    }));
    setNewConstraint('');
  };

  const handleToggleCriteria = async (index) => {
    const newCriteria = [...(editGoal.success_criteria || [])];
    newCriteria[index].checked = !newCriteria[index].checked;
    
    setEditGoal(prev => ({ ...prev, success_criteria: newCriteria }));
    
    // Auto-save criteria toggle
    if (goal) {
      await fetch(`http://localhost:3020/api/goals/${goal.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success_criteria: newCriteria })
      });
      await loadGoal();
    }
  };

  const handleRemoveCriteria = (index) => {
    setEditGoal(prev => ({
      ...prev,
      success_criteria: prev.success_criteria.filter((_, i) => i !== index)
    }));
  };

  const handleRemoveConstraint = (index) => {
    setEditGoal(prev => ({
      ...prev,
      constraints: prev.constraints.filter((_, i) => i !== index)
    }));
  };

  const goalTypes = [
    { value: 'create_deliverable', label: 'Create Deliverable' },
    { value: 'learn', label: 'Learn/Understand' },
    { value: 'debug', label: 'Debug/Solve Problem' },
    { value: 'brainstorm', label: 'Brainstorm/Ideate' },
    { value: 'research', label: 'Research Topic' },
    { value: 'refine', label: 'Refine/Iterate' },
    { value: 'custom', label: 'Custom' }
  ];

  if (!goal && !isEditing) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <button
          onClick={() => setIsEditing(true)}
          className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-gray-700 rounded-lg text-gray-400 hover:text-white hover:border-gray-600 transition-colors"
        >
          <Target size={20} />
          <span>Set Conversation Goal</span>
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-800">
        <div className="flex items-center gap-2">
          <Target size={20} className="text-blue-400" />
          <h3 className="font-semibold text-white">Conversation Goal</h3>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="p-1.5 hover:bg-gray-700 rounded transition-colors text-gray-400 hover:text-white"
          >
            <Edit2 size={16} />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-4">
        {isEditing ? (
          <>
            {/* Goal Text */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Goal Description
              </label>
              <textarea
                value={editGoal.goal_text}
                onChange={(e) => setEditGoal(prev => ({ ...prev, goal_text: e.target.value }))}
                placeholder="What do you want to achieve in this conversation?"
                className="w-full bg-gray-800 text-white rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none"
                rows={3}
              />
            </div>

            {/* Goal Type */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Goal Type
              </label>
              <select
                value={editGoal.goal_type}
                onChange={(e) => setEditGoal(prev => ({ ...prev, goal_type: e.target.value }))}
                className="w-full bg-gray-800 text-white rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none"
              >
                {goalTypes.map(type => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Success Criteria */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Success Criteria
              </label>
              <div className="space-y-2 mb-2">
                {(editGoal.success_criteria || []).map((criteria, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={criteria.checked}
                      onChange={() => handleToggleCriteria(index)}
                      className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                    />
                    <span className={`flex-1 text-sm ${criteria.checked ? 'line-through text-gray-500' : 'text-gray-300'}`}>
                      {criteria.text}
                    </span>
                    <button
                      onClick={() => handleRemoveCriteria(index)}
                      className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCriteria}
                  onChange={(e) => setNewCriteria(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddCriteria()}
                  placeholder="Add success criteria..."
                  className="flex-1 bg-gray-800 text-white rounded px-3 py-1.5 text-sm border border-gray-700 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleAddCriteria}
                  className="p-1.5 bg-blue-600 hover:bg-blue-700 rounded text-white"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {/* Constraints */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Constraints
              </label>
              <div className="space-y-2 mb-2">
                {(editGoal.constraints || []).map((constraint, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="flex-1 text-sm text-gray-300">{constraint}</span>
                    <button
                      onClick={() => handleRemoveConstraint(index)}
                      className="p-1 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newConstraint}
                  onChange={(e) => setNewConstraint(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddConstraint()}
                  placeholder="Add constraint..."
                  className="flex-1 bg-gray-800 text-white rounded px-3 py-1.5 text-sm border border-gray-700 focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleAddConstraint}
                  className="p-1.5 bg-blue-600 hover:bg-blue-700 rounded text-white"
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSave}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium"
              >
                <Check size={16} />
                Save Goal
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white"
              >
                <X size={16} />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Display Mode */}
            <div>
              <div className="text-white font-medium mb-2">{goal.goal_text}</div>
              <div className="text-xs text-gray-400 mb-4">
                Type: {goalTypes.find(t => t.value === goal.goal_type)?.label || goal.goal_type}
              </div>

              {/* Progress */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-gray-400">Progress</span>
                  <span className="text-sm font-medium text-blue-400">{goal.progress}%</span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${goal.progress}%` }}
                  />
                </div>
              </div>

              {/* Success Criteria */}
              {goal.success_criteria && goal.success_criteria.length > 0 && (
                <div className="mb-4">
                  <div className="text-sm font-medium text-gray-300 mb-2">Success Criteria</div>
                  <div className="space-y-1.5">
                    {goal.success_criteria.map((criteria, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={criteria.checked}
                          onChange={() => handleToggleCriteria(index)}
                          className="rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                        />
                        <span className={`text-sm ${criteria.checked ? 'line-through text-gray-500' : 'text-gray-300'}`}>
                          {criteria.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Constraints */}
              {goal.constraints && goal.constraints.length > 0 && (
                <div>
                  <div className="text-sm font-medium text-gray-300 mb-2">Constraints</div>
                  <ul className="space-y-1">
                    {goal.constraints.map((constraint, index) => (
                      <li key={index} className="text-sm text-gray-400">
                        • {constraint}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default GoalPanel;
