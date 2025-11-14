import React, { useState, useEffect } from 'react';
import { GitBranch, Plus, Trash2, Edit2, Check, X } from 'lucide-react';

const BranchNode = ({ branch, isActive, onClick, onRename, onDelete, depth = 0 }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(branch.name || 'Unnamed');

  const handleSaveRename = async () => {
    await onRename(branch.id, editName);
    setIsEditing(false);
  };

  return (
    <div className={`pl-${depth * 4}`}>
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors group
          ${isActive 
            ? 'bg-blue-600 text-white' 
            : 'hover:bg-gray-800 text-gray-300'
          }`}
        onClick={() => !isEditing && onClick(branch.id)}
      >
        <GitBranch size={16} />
        
        {isEditing ? (
          <div className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="flex-1 bg-gray-700 text-white px-2 py-1 rounded text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename();
                if (e.key === 'Escape') setIsEditing(false);
              }}
            />
            <button
              onClick={handleSaveRename}
              className="p-1 hover:bg-green-600 rounded"
            >
              <Check size={14} />
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="p-1 hover:bg-red-600 rounded"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <span className="flex-1 text-sm font-medium truncate">
              {branch.name || 'Unnamed Branch'}
            </span>
            
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setIsEditing(true)}
                className="p-1 hover:bg-gray-700 rounded"
                title="Rename branch"
              >
                <Edit2 size={14} />
              </button>
              {!branch.is_active && (
                <button
                  onClick={() => onDelete(branch.id)}
                  className="p-1 hover:bg-red-600 rounded"
                  title="Delete branch"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </>
        )}
        
        {branch.is_active && (
          <span className="text-xs bg-green-500 px-2 py-0.5 rounded-full">
            Active
          </span>
        )}
      </div>

      {branch.description && (
        <div className="text-xs text-gray-500 px-10 py-1">
          {branch.description}
        </div>
      )}
    </div>
  );
};

export const BranchTree = ({ conversationId, activeBranchId, onBranchSelect }) => {
  const [branches, setBranches] = useState([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  useEffect(() => {
    if (conversationId) {
      loadBranches();
    }
  }, [conversationId]);

  const loadBranches = async () => {
    try {
      const response = await fetch(`http://localhost:3020/api/conversations/${conversationId}/branches`);
      const data = await response.json();
      setBranches(data.branches);
    } catch (error) {
      console.error('Failed to load branches:', error);
    }
  };

  const handleBranchSelect = async (branchId) => {
    try {
      await fetch(`http://localhost:3020/api/branches/${branchId}/activate`, {
        method: 'PUT'
      });
      await loadBranches();
      onBranchSelect(branchId);
    } catch (error) {
      console.error('Failed to activate branch:', error);
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;

    try {
      const activeBranch = branches.find(b => b.id === activeBranchId);
      
      await fetch('http://localhost:3020/api/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `branch-${Date.now()}`,
          conversation_id: conversationId,
          parent_branch_id: activeBranchId,
          name: newBranchName,
          description: `Branched from ${activeBranch?.name || 'main'}`
        })
      });

      setNewBranchName('');
      setIsCreating(false);
      await loadBranches();
    } catch (error) {
      console.error('Failed to create branch:', error);
    }
  };

  const handleRenameBranch = async (branchId, newName) => {
    try {
      await fetch(`http://localhost:3020/api/branches/${branchId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      await loadBranches();
    } catch (error) {
      console.error('Failed to rename branch:', error);
    }
  };

  const handleDeleteBranch = async (branchId) => {
  if (!window.confirm('Delete this branch and all its messages?')) return;
    try {
      await fetch(`http://localhost:3020/api/branches/${branchId}`, {
        method: 'DELETE'
      });
      await loadBranches();
    } catch (error) {
      console.error('Failed to delete branch:', error);
    }
  };

  // Build tree structure
  const buildTree = (branches) => {
    const branchMap = {};
    const roots = [];

    branches.forEach(branch => {
      branchMap[branch.id] = { ...branch, children: [] };
    });

    branches.forEach(branch => {
      if (branch.parent_branch_id && branchMap[branch.parent_branch_id]) {
        branchMap[branch.parent_branch_id].children.push(branchMap[branch.id]);
      } else {
        roots.push(branchMap[branch.id]);
      }
    });

    return roots;
  };

  const renderTree = (nodes, depth = 0) => {
    return nodes.map(node => (
      <div key={node.id}>
        <BranchNode
          branch={node}
          isActive={node.is_active}
          onClick={handleBranchSelect}
          onRename={handleRenameBranch}
          onDelete={handleDeleteBranch}
          depth={depth}
        />
        {node.children && node.children.length > 0 && (
          <div className="ml-4 border-l-2 border-gray-800 pl-2">
            {renderTree(node.children, depth + 1)}
          </div>
        )}
      </div>
    ));
  };

  const tree = buildTree(branches);

  return (
    <div className="h-full flex flex-col bg-gray-900 border-l border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <h2 className="text-lg font-semibold text-white">Branches</h2>
        <button
          onClick={() => setIsCreating(true)}
          className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-white"
          title="Create new branch"
        >
          <Plus size={20} />
        </button>
      </div>

      {/* Branch List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {isCreating && (
          <div className="mb-4 p-3 bg-gray-800 rounded-lg">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="Branch name..."
              className="w-full bg-gray-700 text-white px-3 py-2 rounded mb-2"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateBranch();
                if (e.key === 'Escape') setIsCreating(false);
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreateBranch}
                className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                Create
              </button>
              <button
                onClick={() => setIsCreating(false)}
                className="px-3 py-1.5 bg-gray-700 text-white rounded hover:bg-gray-600 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {tree.length > 0 ? renderTree(tree) : (
          <div className="text-center text-gray-500 py-8">
            No branches yet
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="p-4 border-t border-gray-800 text-sm text-gray-400">
        <div className="flex justify-between">
          <span>{branches.length} branches</span>
          <span>{branches.filter(b => b.is_active).length} active</span>
        </div>
      </div>
    </div>
  );
};

export default BranchTree;
