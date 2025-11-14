/**
 * PROMPT ADVISOR MODULE
 * 
 * Intelligent prompt suggestions and goal-driven conversation guidance.
 * Analyzes conversation goals and suggests optimal next steps.
 * 
 * Features:
 * - Goal creation and tracking
 * - Multi-path prompt suggestions
 * - Progress monitoring
 * - Pattern recognition
 * 
 * Extension Points:
 * - suggestionGenerators: Custom suggestion logic
 * - pathPlanners: Custom path planning algorithms
 * - goalAnalyzers: Custom goal analysis
 */

const { q } = require('../db');
const { getConversation, getConversationMessages } = require('./conversations');

// Extension registries
const suggestionGenerators = new Map();
const pathPlanners = new Map();
const goalAnalyzers = new Map();

/**
 * Module metadata
 */
const version = '1.0.0';
const description = 'Goal-driven prompt advisor and conversation guidance';
const endpoints = [
  'POST /api/advisor/goals',
  'GET /api/advisor/goals/:conversationId',
  'PUT /api/advisor/goals/:goalId',
  'POST /api/advisor/suggest',
  'GET /api/advisor/patterns',
  'POST /api/advisor/analyze'
];

/**
 * Initialize module with default generators
 */
async function initialize() {
  registerSuggestionGenerator('next_prompt', nextPromptGenerator);
  registerSuggestionGenerator('multi_path', multiPathGenerator);
  registerSuggestionGenerator('blocker_detection', blockerDetectionGenerator);
  registerSuggestionGenerator('quality_check', qualityCheckGenerator);
  
  registerPathPlanner('direct', directPathPlanner);
  registerPathPlanner('exploratory', exploratoryPathPlanner);
  registerPathPlanner('iterative', iterativePathPlanner);
  
  return true;
}

// ========== GOAL MANAGEMENT ==========

/**
 * Create conversation goal
 */
async function createGoal({
  conversationId,
  goalText,
  goalType = 'custom',
  successCriteria = [],
  constraints = {}
}) {
  const { rows } = await q(`
    INSERT INTO conversation_goals(
      conversation_id, goal_text, goal_type, 
      success_criteria, constraints
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [
    conversationId,
    goalText,
    goalType,
    JSON.stringify(successCriteria),
    JSON.stringify(constraints)
  ]);

  return rows[0];
}

/**
 * Get goal for conversation
 */
async function getConversationGoal(conversationId) {
  const { rows } = await q(`
    SELECT * FROM conversation_goals
    WHERE conversation_id = $1 
    AND completed = false
    ORDER BY created_at DESC
    LIMIT 1
  `, [conversationId]);

  return rows[0];
}

/**
 * Update goal
 */
async function updateGoal(goalId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.goal_text !== undefined) {
    fields.push(`goal_text = $${idx++}`);
    values.push(updates.goal_text);
  }
  if (updates.success_criteria !== undefined) {
    fields.push(`success_criteria = $${idx++}`);
    values.push(JSON.stringify(updates.success_criteria));
  }
  if (updates.constraints !== undefined) {
    fields.push(`constraints = $${idx++}`);
    values.push(JSON.stringify(updates.constraints));
  }
  if (updates.progress !== undefined) {
    fields.push(`progress = $${idx++}`);
    values.push(updates.progress);
  }
  if (updates.completed !== undefined) {
    fields.push(`completed = $${idx++}`);
    values.push(updates.completed);
  }

  fields.push(`updated_at = now()`);
  values.push(goalId);

  const { rows } = await q(`
    UPDATE conversation_goals
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);

  return rows[0];
}

/**
 * Calculate goal progress
 */
async function calculateGoalProgress(goalId) {
  const { rows } = await q(
    'SELECT * FROM conversation_goals WHERE id = $1',
    [goalId]
  );
  
  if (!rows[0]) {
    throw new Error('Goal not found');
  }

  const goal = rows[0];
  const criteria = goal.success_criteria || [];
  
  if (criteria.length === 0) {
    // No criteria defined, estimate based on conversation
    return estimateProgressFromConversation(goal.conversation_id, goal);
  }

  // Calculate based on completed criteria
  const completedCount = criteria.filter(c => c.completed).length;
  const progress = Math.floor((completedCount / criteria.length) * 100);

  await updateGoal(goalId, { progress });

  return progress;
}

/**
 * Estimate progress from conversation analysis
 */
async function estimateProgressFromConversation(conversationId, goal) {
  // Simple heuristic: more messages = more progress
  // In production, this would use LLM analysis
  const messages = await getConversationMessages(conversationId);
  const estimatedSteps = 10; // Assumed average steps to complete goal
  const progress = Math.min(100, Math.floor((messages.length / estimatedSteps) * 100));
  
  return progress;
}

// ========== SUGGESTION GENERATION ==========

/**
 * Generate suggestions for next steps
 */
async function generateSuggestions({
  conversationId,
  goalId = null,
  suggestionTypes = ['next_prompt', 'multi_path'],
  count = 3
}) {
  const conversation = await getConversation(conversationId);
  const messages = await getConversationMessages(conversationId);
  const goal = goalId ? await q('SELECT * FROM conversation_goals WHERE id = $1', [goalId]).then(r => r.rows[0]) : null;

  const allSuggestions = [];

  for (const type of suggestionTypes) {
    const generator = suggestionGenerators.get(type);
    if (generator) {
      const suggestions = await generator({
        conversation,
        messages,
        goal,
        count
      });
      allSuggestions.push(...suggestions);
    }
  }

  // Store suggestions for analytics
  if (goal) {
    await q(`
      INSERT INTO advisor_suggestions(
        conversation_id, goal_id, suggestion_type, suggestions
      )
      VALUES ($1, $2, $3, $4)
    `, [conversationId, goalId, suggestionTypes.join(','), JSON.stringify(allSuggestions)]);
  }

  return allSuggestions;
}

/**
 * Record which suggestion was selected
 */
async function recordSuggestionSelection(suggestionId, selectedIndex) {
  await q(`
    UPDATE advisor_suggestions
    SET selected_index = $1
    WHERE id = $2
  `, [selectedIndex, suggestionId]);
}

// ========== PATH PLANNING ==========

/**
 * Generate conversation roadmap
 */
async function generateRoadmap({
  conversationId,
  goalId,
  strategy = 'direct'
}) {
  const goal = await q(
    'SELECT * FROM conversation_goals WHERE id = $1',
    [goalId]
  ).then(r => r.rows[0]);
  
  if (!goal) {
    throw new Error('Goal not found');
  }

  const planner = pathPlanners.get(strategy);
  if (!planner) {
    throw new Error(`Unknown path planning strategy: ${strategy}`);
  }

  const messages = await getConversationMessages(conversationId);
  const roadmap = await planner({ goal, messages });

  return roadmap;
}

// ========== DEFAULT GENERATORS ==========

/**
 * Generate next prompt suggestions
 */
async function nextPromptGenerator({ conversation, messages, goal, count }) {
  const suggestions = [];
  
  const lastMessage = messages[messages.length - 1];
  const isUserTurn = !lastMessage || lastMessage.role !== 'user';

  if (isUserTurn) {
    // Suggest prompts based on conversation state
    if (messages.length === 0) {
      suggestions.push({
        type: 'next_prompt',
        label: 'Start with Requirements',
        prompt: goal ? `Let's start by defining the requirements for: ${goal.goal_text}` : 'Let\'s start by defining what we want to achieve.',
        rationale: 'Begin by clarifying objectives',
        estimated_exchanges: 2,
        confidence: 0.9
      });
    } else {
      // Analyze last assistant response and suggest follow-ups
      suggestions.push({
        type: 'next_prompt',
        label: 'Continue Implementation',
        prompt: 'Let\'s continue with the implementation.',
        rationale: 'Progress toward goal',
        estimated_exchanges: 3,
        confidence: 0.7
      });
      
      suggestions.push({
        type: 'next_prompt',
        label: 'Review and Refine',
        prompt: 'Can you review what we have so far and suggest improvements?',
        rationale: 'Quality check before proceeding',
        estimated_exchanges: 2,
        confidence: 0.8
      });
    }
  }

  return suggestions.slice(0, count);
}

/**
 * Generate multiple path options
 */
async function multiPathGenerator({ conversation, messages, goal, count }) {
  const suggestions = [];

  if (goal) {
    // Direct path
    suggestions.push({
      type: 'path',
      label: '🎯 Most Direct Path',
      description: 'Fastest route to goal',
      approach: 'direct',
      estimated_exchanges: 5,
      estimated_cost: 0.15,
      confidence: 0.85,
      steps: [
        'Define requirements',
        'Create implementation',
        'Test and validate',
        'Document'
      ]
    });

    // Thorough path
    suggestions.push({
      type: 'path',
      label: '🧠 Deep Dive',
      description: 'Comprehensive exploration',
      approach: 'exploratory',
      estimated_exchanges: 10,
      estimated_cost: 0.35,
      confidence: 0.92,
      steps: [
        'Research best practices',
        'Evaluate options',
        'Design solution',
        'Implement incrementally',
        'Test thoroughly',
        'Optimize',
        'Document comprehensively'
      ]
    });

    // Cautious path
    suggestions.push({
      type: 'path',
      label: '🔍 Validate First',
      description: 'Risk-aware approach',
      approach: 'iterative',
      estimated_exchanges: 7,
      estimated_cost: 0.22,
      confidence: 0.88,
      steps: [
        'Identify potential issues',
        'Create prototype',
        'Validate approach',
        'Implement with safeguards',
        'Test edge cases'
      ]
    });
  }

  return suggestions.slice(0, count);
}

/**
 * Detect potential blockers
 */
async function blockerDetectionGenerator({ conversation, messages, goal }) {
  const suggestions = [];

  // Simple heuristic: check for repeated similar prompts (indicates confusion)
  const recentPrompts = messages.slice(-5).filter(m => m.role === 'user');
  
  if (recentPrompts.length >= 3) {
    const similarityThreshold = 0.7;
    // In production, use actual similarity calculation
    const hasRepetition = false; // Placeholder
    
    if (hasRepetition) {
      suggestions.push({
        type: 'blocker',
        severity: 'warning',
        message: 'Detected repeated similar prompts. May need to clarify approach.',
        suggested_action: 'Try a different angle or ask for explanation of the issue.',
        confidence: 0.75
      });
    }
  }

  // Check if goal progress is stalled
  if (goal && messages.length > 10) {
    const progress = await calculateGoalProgress(goal.id);
    if (progress < 20) {
      suggestions.push({
        type: 'blocker',
        severity: 'info',
        message: 'Goal progress is slow. Consider breaking into smaller steps.',
        suggested_action: 'Create intermediate milestones or simplify approach.',
        confidence: 0.6
      });
    }
  }

  return suggestions;
}

/**
 * Quality check suggestions
 */
async function qualityCheckGenerator({ conversation, messages, goal }) {
  const suggestions = [];

  if (messages.length > 5) {
    // Check if any validation has been done
    const hasValidation = messages.some(m => 
      m.content && (
        m.content.toLowerCase().includes('test') ||
        m.content.toLowerCase().includes('validate') ||
        m.content.toLowerCase().includes('review')
      )
    );

    if (!hasValidation) {
      suggestions.push({
        type: 'quality',
        severity: 'warning',
        message: 'No validation steps detected yet.',
        suggested_action: 'Consider adding testing or review before proceeding further.',
        confidence: 0.7
      });
    }
  }

  return suggestions;
}

// ========== PATH PLANNERS ==========

async function directPathPlanner({ goal, messages }) {
  return {
    strategy: 'direct',
    name: 'Direct Path to Goal',
    estimated_exchanges: 5,
    estimated_cost: 0.15,
    steps: [
      { order: 1, description: 'Define clear requirements', status: 'pending' },
      { order: 2, description: 'Implement solution', status: 'pending' },
      { order: 3, description: 'Test functionality', status: 'pending' },
      { order: 4, description: 'Add documentation', status: 'pending' },
      { order: 5, description: 'Final review', status: 'pending' }
    ]
  };
}

async function exploratoryPathPlanner({ goal, messages }) {
  return {
    strategy: 'exploratory',
    name: 'Comprehensive Exploration',
    estimated_exchanges: 10,
    estimated_cost: 0.35,
    steps: [
      { order: 1, description: 'Research and gather information', status: 'pending' },
      { order: 2, description: 'Explore alternative approaches', status: 'pending' },
      { order: 3, description: 'Compare pros and cons', status: 'pending' },
      { order: 4, description: 'Select best approach', status: 'pending' },
      { order: 5, description: 'Design detailed solution', status: 'pending' },
      { order: 6, description: 'Implement incrementally', status: 'pending' },
      { order: 7, description: 'Test each component', status: 'pending' },
      { order: 8, description: 'Integrate and test', status: 'pending' },
      { order: 9, description: 'Optimize performance', status: 'pending' },
      { order: 10, description: 'Document thoroughly', status: 'pending' }
    ]
  };
}

async function iterativePathPlanner({ goal, messages }) {
  return {
    strategy: 'iterative',
    name: 'Iterative Development',
    estimated_exchanges: 8,
    estimated_cost: 0.25,
    steps: [
      { order: 1, description: 'Create minimal prototype', status: 'pending' },
      { order: 2, description: 'Test and gather feedback', status: 'pending' },
      { order: 3, description: 'Refine based on feedback', status: 'pending' },
      { order: 4, description: 'Add next feature set', status: 'pending' },
      { order: 5, description: 'Test again', status: 'pending' },
      { order: 6, description: 'Continue iterations', status: 'pending' },
      { order: 7, description: 'Polish and optimize', status: 'pending' },
      { order: 8, description: 'Final validation', status: 'pending' }
    ]
  };
}

// ========== PATTERNS ==========

/**
 * Save successful conversation pattern
 */
async function saveConversationPattern({
  name,
  goalType,
  description,
  conversationId
}) {
  const messages = await getConversationMessages(conversationId);
  
  const promptSequence = messages
    .filter(m => m.role === 'user')
    .map(m => ({
      content: m.content,
      tokens: m.tokens
    }));

  const { rows } = await q(`
    INSERT INTO conversation_patterns(
      name, goal_type, description, prompt_sequence,
      avg_exchanges, tags
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    name,
    goalType,
    description,
    JSON.stringify(promptSequence),
    messages.length,
    []
  ]);

  return rows[0];
}

/**
 * Get conversation patterns
 */
async function getConversationPatterns(goalType = null) {
  let query = 'SELECT * FROM conversation_patterns WHERE 1=1';
  const params = [];
  
  if (goalType) {
    query += ' AND goal_type = $1';
    params.push(goalType);
  }
  
  query += ' ORDER BY usage_count DESC, success_rate DESC LIMIT 20';
  
  const { rows } = await q(query, params);
  return rows;
}

// ========== EXTENSION POINTS ==========

function registerSuggestionGenerator(name, handler) {
  suggestionGenerators.set(name, handler);
}

function registerPathPlanner(name, handler) {
  pathPlanners.set(name, handler);
}

function registerGoalAnalyzer(name, handler) {
  goalAnalyzers.set(name, handler);
}

module.exports = {
  // Metadata
  version,
  description,
  endpoints,
  
  // Lifecycle
  initialize,
  
  // Goals
  createGoal,
  getConversationGoal,
  updateGoal,
  calculateGoalProgress,
  
  // Suggestions
  generateSuggestions,
  recordSuggestionSelection,
  
  // Planning
  generateRoadmap,
  
  // Patterns
  saveConversationPattern,
  getConversationPatterns,
  
  // Extensions
  registerSuggestionGenerator,
  registerPathPlanner,
  registerGoalAnalyzer
};
