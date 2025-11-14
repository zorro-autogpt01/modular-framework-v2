import React, { useState, useEffect } from 'react';
import { ConversationView } from './components/ConversationView';
import { BranchTree } from './components/BranchTree';
import { GoalPanel } from './components/GoalPanel';
import { PersonalitySelector, SmartActions, PromptAdvisor } from './components/Controls';
import { Settings } from 'lucide-react';

const App = () => {
  const [conversationId, setConversationId] = useState(null);
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [personalityId, setPersonalityId] = useState(null);
  const [goal, setGoal] = useState(null);
  const [activeTab, setActiveTab] = useState('tree');
  const [selectedText, setSelectedText] = useState('');

  useEffect(() => {
    initializeConversation();
  }, []);

  const initializeConversation = async () => {
    try {
      const response = await fetch('http://localhost:3010/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `conv-${Date.now()}`,
          title: 'New Conversation'
        })
      });

      const data = await response.json();
      const convId = data.conversation.id;
      setConversationId(convId);

      const branchResp = await fetch('http://localhost:3020/api/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `branch-main-${Date.now()}`,
          conversation_id: convId,
          name: 'main',
          is_active: true
        })
      });

      const branchData = await branchResp.json();
      setActiveBranchId(branchData.branch.id);
    } catch (error) {
      console.error('Failed to initialize conversation:', error);
    }
  };

  const handleSendMessage = async (message) => {
    try {
      const response = await fetch('http://localhost:3020/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          branch_id: activeBranchId,
          personality_id: personalityId,
          message,
          model: 'gpt-4o-mini',
          stream: false
        })
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  };

  const handleBranchCreate = async (fromMessageId) => {
    const branchName = prompt('Enter branch name:');
    if (!branchName) return;

    try {
      const response = await fetch('http://localhost:3020/api/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `branch-${Date.now()}`,
          conversation_id: conversationId,
          parent_branch_id: activeBranchId,
          branch_point_message_id: fromMessageId,
          name: branchName
        })
      });

      const data = await response.json();
      
      await fetch(`http://localhost:3020/api/branches/${data.branch.id}/activate`, {
        method: 'PUT'
      });

      setActiveBranchId(data.branch.id);
    } catch (error) {
      console.error('Failed to create branch:', error);
    }
  };

  const tabs = [
    { id: 'tree', label: 'Tree', icon: '🌳' },
    { id: 'advisor', label: 'Advisor', icon: '🎯' },
    { id: 'actions', label: 'Actions', icon: '⚡' },
    { id: 'context', label: 'Context', icon: '📊' },
    { id: 'schemas', label: 'Schemas', icon: '📋' }
  ];

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col">
      <div className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-4">
        <h1 className="text-xl font-bold text-blue-400">LLM Chat Pro</h1>
        <div className="flex-1" />
        <div className="w-64">
          <PersonalitySelector
            currentPersonalityId={personalityId}
            onPersonalityChange={setPersonalityId}
          />
        </div>
        <button className="p-2 hover:bg-gray-800 rounded-lg">
          <Settings size={20} />
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/3 flex flex-col border-r border-gray-800">
          <ConversationView
            conversationId={conversationId}
            branchId={activeBranchId}
            onSendMessage={handleSendMessage}
            onBranchCreate={handleBranchCreate}
          />
        </div>

        <div className="flex-1 flex flex-col">
          <div className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                  ${activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'tree' && (
              <BranchTree
                conversationId={conversationId}
                activeBranchId={activeBranchId}
                onBranchSelect={setActiveBranchId}
              />
            )}

            {activeTab === 'advisor' && (
              <div className="space-y-4">
                <GoalPanel conversationId={conversationId} />
                <PromptAdvisor
                  conversationId={conversationId}
                  goal={goal}
                  onSuggestionSelect={(s) => console.log('Suggestion:', s)}
                />
              </div>
            )}

            {activeTab === 'actions' && (
              <SmartActions
                onActionSelect={(a, p) => console.log('Action:', a, p)}
                selectedText={selectedText}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
