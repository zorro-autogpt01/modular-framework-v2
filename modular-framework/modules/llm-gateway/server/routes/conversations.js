const express = require('express');
const router = express.Router();
const { ah } = require('../utils/asyncHandler');
const { validate, str, num, bool, obj } = require('../utils/validate');
const {
  listConversations, getConversation, createConversation, 
  updateConversation, deleteConversation,
  getConversationMessages, addConversationMessage, truncateConversationMessages
} = require('../db');
const { logInfo, logDebug } = require('../logger');
const { countChatTokens } = require('../utils/tokens');

// List conversations with optional search
router.get('/conversations', ah(async (req, res) => {
  logInfo('GW /api/conversations list', { 
    query: req.query, 
    ip: req.ip 
  });

  const opts = {
    limit: Math.min(Number(req.query.limit || 50), 200),
    archived: req.query.archived === 'true',
    search: req.query.search || null
  };

  const items = await listConversations(opts);
  res.json({ items });
}));

// Get single conversation (metadata only)
router.get('/conversations/:id', ah(async (req, res) => {
  logInfo('GW /api/conversations get', { 
    id: req.params.id, 
    ip: req.ip 
  });

  const conv = await getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  
  res.json({ conversation: conv });
}));

// Create new conversation
router.post('/conversations', ah(async (req, res) => {
  logInfo('GW /api/conversations create', { 
    body: req.body, 
    ip: req.ip 
  });

  const data = validate(req.body || {}, {
    id: str().min(1),
    title: str().optional(),
    system_prompt: str().optional(),
    model_id: num().optional(),
    meta: obj().optional()
  });

  const conv = await createConversation(data);
  res.json({ ok: true, conversation: conv });
}));

// Update conversation metadata
router.put('/conversations/:id', ah(async (req, res) => {
  logInfo('GW /api/conversations update', { 
    id: req.params.id, 
    body: req.body, 
    ip: req.ip 
  });

  const updates = validate(req.body || {}, {
    title: str().optional(),
    system_prompt: str().optional(),
    model_id: num().optional(),
    meta: obj().optional(),
    archived: bool().optional()
  });

  const conv = await updateConversation(req.params.id, updates);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  res.json({ ok: true, conversation: conv });
}));

// Delete conversation (and all messages)
router.delete('/conversations/:id', ah(async (req, res) => {
  logInfo('GW /api/conversations delete', { 
    id: req.params.id, 
    ip: req.ip 
  });

  await deleteConversation(req.params.id);
  res.json({ ok: true });
}));

// Get conversation messages (paginated)
router.get('/conversations/:id/messages', ah(async (req, res) => {
  logInfo('GW /api/conversations/:id/messages list', { 
    id: req.params.id,
    query: req.query,
    ip: req.ip 
  });

  const opts = {
    limit: Math.min(Number(req.query.limit || 100), 500),
    before: req.query.before ? Number(req.query.before) : null
  };

  const messages = await getConversationMessages(req.params.id, opts);
  res.json({ items: messages });
}));

// Add message to conversation
router.post('/conversations/:id/messages', ah(async (req, res) => {
  logInfo('GW /api/conversations/:id/messages add', { 
    id: req.params.id,
    body: req.body,
    ip: req.ip 
  });

  const data = validate(req.body || {}, {
    role: str().min(1),
    content: str().optional(),
    tokens: num().optional(),
    cost: num().optional(),
    meta: obj().optional()
  });

  // Auto-calculate tokens if not provided
  if (!data.tokens && data.content) {
    data.tokens = countChatTokens([{ role: data.role, content: data.content }]);
  }

  const msg = await addConversationMessage({
    conversation_id: req.params.id,
    ...data
  });

  res.json({ ok: true, message: msg });
}));

// Truncate old messages to fit context window
router.post('/conversations/:id/truncate', ah(async (req, res) => {
  logInfo('GW /api/conversations/:id/truncate', { 
    id: req.params.id,
    body: req.body,
    ip: req.ip 
  });

  const { max_tokens } = validate(req.body || {}, {
    max_tokens: num().min(1)
  });

  const deletedCount = await truncateConversationMessages(
    req.params.id, 
    max_tokens
  );

  res.json({ 
    ok: true, 
    deleted_messages: deletedCount,
    message: `Removed ${deletedCount} old messages to stay within ${max_tokens} tokens`
  });
}));

// Get full conversation export (metadata + all messages)
router.get('/conversations/:id/export', ah(async (req, res) => {
  logInfo('GW /api/conversations/:id/export', { 
    id: req.params.id,
    ip: req.ip 
  });

  const conv = await getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const messages = await getConversationMessages(req.params.id, { limit: 10000 });

  res.json({
    conversation: conv,
    messages,
    exported_at: new Date().toISOString()
  });
}));

module.exports = { router };