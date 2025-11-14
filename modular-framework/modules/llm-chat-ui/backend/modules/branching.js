/**
 * BRANCHING MODULE
 * 
 * Manages conversation trees and branching logic.
 * Handles creating branches, tracking relationships, and tree traversal.
 * 
 * Features:
 * - Create branches from any message
 * - Get conversation tree structure
 * - Branch comparison and merging
 * - Cherry-picking messages between branches
 * 
 * Extension Points:
 * - branchStrategies: Custom branching logic
 * - mergeHandlers: Custom merge strategies
 */

const { q } = require('../db');
const { getConversation, createConversation, getConversationMessages } = require('./conversations');

// Extension registries
const branchStrategies = new Map();
const mergeHandlers = new Map();

/**
 * Module metadata
 */
const version = '1.0.0';
const description = 'Conversation tree and branching management';
const endpoints = [
  'POST /api/conversations/:id/branch',
  'GET /api/conversations/:id/tree',
  'GET /api/conversations/:id/branches',
  'POST /api/conversations/merge',
  'POST /api/conversations/cherry-pick'
];

/**
 * Initialize module
 */
async function initialize() {
  // Register default branch strategies
  registerBranchStrategy('manual', manualBranchStrategy);
  registerBranchStrategy('advisor', advisorBranchStrategy);
  registerBranchStrategy('comparison', comparisonBranchStrategy);
  return true;
}

// ========== BRANCHING ==========

/**
 * Create a new branch from a conversation at a specific message
 */
async function createBranch({
  parentConversationId,
  branchFromMessageId,
  branchType = 'manual',
  title = null,
  copyMessagesUpTo = true,
  meta = {}
}) {
  const parentConv = await getConversation(parentConversationId);
  if (!parentConv) {
    throw new Error('Parent conversation not found');
  }

  // Generate new conversation ID
  const newConvId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Create new conversation as branch
  const newConv = await createConversation({
    id: newConvId,
    title: title || `${parentConv.title || 'Conversation'} (Branch)`,
    system_prompt: parentConv.system_prompt,
    model_id: parentConv.model_id,
    personality_id: parentConv.personality_id,
    parent_branch_id: parentConversationId,
    branch_point_message_id: branchFromMessageId,
    meta: { ...parentConv.meta, ...meta, is_branch: true }
  });

  // Record branch relationship
  await q(`
    INSERT INTO conversation_branches(
      parent_conversation_id, child_conversation_id, 
      branch_message_id, branch_type, meta
    )
    VALUES ($1, $2, $3, $4, $5)
  `, [parentConversationId, newConvId, branchFromMessageId, branchType, meta]);

  // Copy messages up to branch point if requested
  if (copyMessagesUpTo && branchFromMessageId) {
    const messages = await getConversationMessages(parentConversationId, { limit: 1000 });
    const messagesToCopy = messages.filter(m => m.id <= branchFromMessageId);
    
    for (const msg of messagesToCopy) {
      await q(`
        INSERT INTO conversation_messages(
          conversation_id, role, content, tokens, cost, 
          in_context, priority, pinned, meta
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        newConvId,
        msg.role,
        msg.content,
        msg.tokens,
        msg.cost,
        msg.in_context,
        msg.priority,
        msg.pinned,
        { ...msg.meta, copied_from_message_id: msg.id }
      ]);
    }
  }

  return newConv;
}

/**
 * Get all branches for a conversation
 */
async function getConversationBranches(conversationId) {
  const { rows } = await q(`
    SELECT 
      cb.*,
      c.title as branch_title,
      c.created_at as branch_created_at,
      c.archived as branch_archived,
      (
        SELECT COUNT(*) FROM conversation_messages 
        WHERE conversation_id = c.id
      ) as branch_message_count
    FROM conversation_branches cb
    JOIN conversations c ON c.id = cb.child_conversation_id
    WHERE cb.parent_conversation_id = $1
    ORDER BY cb.created_at DESC
  `, [conversationId]);
  
  return rows;
}

/**
 * Get full conversation tree structure
 */
async function getConversationTree(rootConversationId) {
  async function buildTree(convId, visited = new Set()) {
    if (visited.has(convId)) {
      return null; // Prevent infinite loops
    }
    visited.add(convId);

    const conv = await getConversation(convId);
    if (!conv) return null;

    const branches = await getConversationBranches(convId);
    const children = [];

    for (const branch of branches) {
      const childTree = await buildTree(branch.child_conversation_id, visited);
      if (childTree) {
        children.push({
          ...childTree,
          branchInfo: {
            branch_message_id: branch.branch_message_id,
            branch_type: branch.branch_type,
            created_at: branch.created_at
          }
        });
      }
    }

    return {
      id: conv.id,
      title: conv.title,
      message_count: conv.message_count,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      personality_name: conv.personality_name,
      archived: conv.archived,
      children
    };
  }

  return buildTree(rootConversationId);
}

/**
 * Get path from root to specific conversation
 */
async function getBranchPath(conversationId) {
  const path = [];
  let currentId = conversationId;

  while (currentId) {
    const conv = await getConversation(currentId);
    if (!conv) break;

    path.unshift({
      id: conv.id,
      title: conv.title,
      branch_point_message_id: conv.branch_point_message_id
    });

    currentId = conv.parent_branch_id;
  }

  return path;
}

// ========== BRANCH COMPARISON ==========

/**
 * Compare two branches
 */
async function compareBranches(conversationId1, conversationId2) {
  const [messages1, messages2] = await Promise.all([
    getConversationMessages(conversationId1, { limit: 1000 }),
    getConversationMessages(conversationId2, { limit: 1000 })
  ]);

  // Find divergence point
  let divergenceIndex = 0;
  for (let i = 0; i < Math.min(messages1.length, messages2.length); i++) {
    if (messages1[i].content !== messages2[i].content) {
      divergenceIndex = i;
      break;
    }
  }

  return {
    conversation1: {
      id: conversationId1,
      message_count: messages1.length,
      messages: messages1
    },
    conversation2: {
      id: conversationId2,
      message_count: messages2.length,
      messages: messages2
    },
    divergence_point: divergenceIndex,
    common_messages: divergenceIndex,
    unique_to_conv1: messages1.slice(divergenceIndex),
    unique_to_conv2: messages2.slice(divergenceIndex)
  };
}

// ========== BRANCH MERGING ==========

/**
 * Merge messages from one branch into another
 */
async function mergeBranches({
  targetConversationId,
  sourceConversationId,
  strategy = 'append',
  messageIds = null
}) {
  const handler = mergeHandlers.get(strategy);
  if (!handler) {
    throw new Error(`Unknown merge strategy: ${strategy}`);
  }

  return handler({
    targetConversationId,
    sourceConversationId,
    messageIds
  });
}

/**
 * Cherry-pick specific messages to another branch
 */
async function cherryPickMessages({
  targetConversationId,
  sourceMessageIds
}) {
  const pickedMessages = [];

  for (const msgId of sourceMessageIds) {
    const { rows } = await q(
      'SELECT * FROM conversation_messages WHERE id = $1',
      [msgId]
    );
    
    if (rows[0]) {
      const msg = rows[0];
      const { rows: inserted } = await q(`
        INSERT INTO conversation_messages(
          conversation_id, role, content, tokens, cost, 
          in_context, priority, pinned, meta
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        targetConversationId,
        msg.role,
        msg.content,
        msg.tokens,
        msg.cost,
        msg.in_context,
        msg.priority,
        msg.pinned,
        { 
          ...msg.meta, 
          cherry_picked_from: msg.id,
          cherry_picked_at: new Date().toISOString()
        }
      ]);
      
      pickedMessages.push(inserted[0]);
    }
  }

  return pickedMessages;
}

// ========== DEFAULT STRATEGIES ==========

async function manualBranchStrategy(params) {
  // Simple manual branching - just create the branch
  return params;
}

async function advisorBranchStrategy(params) {
  // Advisor-suggested branch - could add metadata
  return {
    ...params,
    meta: {
      ...params.meta,
      suggested_by: 'advisor',
      suggestion_reason: params.meta?.suggestion_reason
    }
  };
}

async function comparisonBranchStrategy(params) {
  // Create branch for A/B comparison
  return {
    ...params,
    meta: {
      ...params.meta,
      purpose: 'comparison',
      compare_with: params.meta?.compare_with
    }
  };
}

/**
 * Default merge strategy: append messages
 */
async function appendMergeStrategy({ targetConversationId, sourceConversationId, messageIds }) {
  const sourceMessages = messageIds 
    ? await Promise.all(messageIds.map(id => 
        q('SELECT * FROM conversation_messages WHERE id = $1', [id])
          .then(r => r.rows[0])
      ))
    : await getConversationMessages(sourceConversationId);

  const merged = [];
  for (const msg of sourceMessages) {
    if (!msg) continue;
    
    const { rows } = await q(`
      INSERT INTO conversation_messages(
        conversation_id, role, content, tokens, cost, 
        in_context, priority, pinned, meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      targetConversationId,
      msg.role,
      msg.content,
      msg.tokens,
      msg.cost,
      msg.in_context,
      msg.priority,
      msg.pinned,
      { 
        ...msg.meta, 
        merged_from: sourceConversationId,
        original_message_id: msg.id
      }
    ]);
    
    merged.push(rows[0]);
  }

  return merged;
}

// ========== EXTENSION POINTS ==========

/**
 * Register custom branch strategy
 */
function registerBranchStrategy(name, handler) {
  branchStrategies.set(name, handler);
}

/**
 * Register custom merge handler
 */
function registerMergeHandler(name, handler) {
  mergeHandlers.set(name, handler);
}

// Register default merge strategies
registerMergeHandler('append', appendMergeStrategy);

module.exports = {
  // Metadata
  version,
  description,
  endpoints,
  
  // Lifecycle
  initialize,
  
  // Branching
  createBranch,
  getConversationBranches,
  getConversationTree,
  getBranchPath,
  
  // Comparison
  compareBranches,
  
  // Merging
  mergeBranches,
  cherryPickMessages,
  
  // Extensions
  registerBranchStrategy,
  registerMergeHandler
};
