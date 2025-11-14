/**
 * API SERVICE
 * 
 * Central API client for all backend communication.
 * All API calls go through this service.
 */

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3020';

const client = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request interceptor for logging
client.interceptors.request.use(request => {
  console.log('API Request:', request.method.toUpperCase(), request.url);
  return request;
});

// Response interceptor for error handling
client.interceptors.response.use(
  response => response.data,
  error => {
    console.error('API Error:', error.response?.data || error.message);
    throw error;
  }
);

/**
 * API Methods
 */
export const api = {
  // ========== Conversations ==========
  listConversations: (params = {}) => 
    client.get('/api/conversations', { params }),
  
  getConversation: (id) => 
    client.get(`/api/conversations/${id}`),
  
  createConversation: (data) => 
    client.post('/api/conversations', data),
  
  updateConversation: (id, data) => 
    client.put(`/api/conversations/${id}`, data),
  
  deleteConversation: (id) => 
    client.delete(`/api/conversations/${id}`),
  
  exportConversation: (id) => 
    client.get(`/api/conversations/${id}/export`),

  // ========== Messages ==========
  getMessages: (conversationId, params = {}) => 
    client.get(`/api/conversations/${conversationId}/messages`, { params }),
  
  addMessage: (conversationId, message) => 
    client.post(`/api/conversations/${conversationId}/messages`, message),

  // ========== Branching ==========
  createBranch: (conversationId, data) => 
    client.post(`/api/conversations/${conversationId}/branch`, data),
  
  getBranches: (conversationId) => 
    client.get(`/api/conversations/${conversationId}/branches`),
  
  getTree: (conversationId) => 
    client.get(`/api/conversations/${conversationId}/tree`),
  
  compareBranches: (conv1, conv2) => 
    client.post('/api/conversations/compare', { 
      conversation_id_1: conv1, 
      conversation_id_2: conv2 
    }),

  // ========== Context Management ==========
  getContextState: (conversationId, params = {}) => 
    client.get(`/api/context/${conversationId}`, { params }),
  
  optimizeContext: (conversationId, options) => 
    client.post(`/api/context/${conversationId}/optimize`, options),
  
  updateMessagePriority: (messageId, priority) => 
    client.put(`/api/context/messages/${messageId}/priority`, { priority }),
  
  getContextStrategies: () => 
    client.get('/api/context/strategies'),

  // ========== Prompt Advisor ==========
  createGoal: (data) => 
    client.post('/api/advisor/goals', data),
  
  getConversationGoal: (conversationId) => 
    client.get(`/api/advisor/goals/${conversationId}`),
  
  updateGoal: (goalId, data) => 
    client.put(`/api/advisor/goals/${goalId}`, data),
  
  generateSuggestions: (data) => 
    client.post('/api/advisor/suggest', data),
  
  generateRoadmap: (data) => 
    client.post('/api/advisor/roadmap', data),
  
  getPatterns: (goalType = null) => 
    client.get('/api/advisor/patterns', { params: { goal_type: goalType } }),

  // ========== Personalities ==========
  listPersonalities: (params = {}) => 
    client.get('/api/personalities', { params }),
  
  getPersonality: (id) => 
    client.get(`/api/personalities/${id}`),
  
  createPersonality: (data) => 
    client.post('/api/personalities', data),

  // ========== Schemas ==========
  listSchemas: (params = {}) => 
    client.get('/api/schemas', { params }),
  
  getSchema: (id) => 
    client.get(`/api/schemas/${id}`),
  
  createSchema: (data) => 
    client.post('/api/schemas', data),
  
  validateData: (schemaId, data) => 
    client.post('/api/schemas/validate', { schema_id: schemaId, data }),
  
  inferSchemaFromExample: (example) => 
    client.post('/api/schemas/from-example', { example }),

  // ========== Templates ==========
  listTemplates: (params = {}) => 
    client.get('/api/templates', { params }),
  
  createTemplate: (data) => 
    client.post('/api/templates', data),
  
  renderTemplate: (id, variables) => 
    client.post(`/api/templates/${id}/render`, { variables }),

  // ========== Smart Actions ==========
  listActions: (params = {}) => 
    client.get('/api/actions', { params }),
  
  executeAction: (name, context) => 
    client.post(`/api/actions/${name}/execute`, context),

  // ========== Chat ==========
  sendMessage: (data) => 
    client.post('/api/chat', data),
  
  /**
   * Stream chat response using Server-Sent Events
   */
  streamChat: async (data, onChunk, onComplete, onError) => {
    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...data, stream: true })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          onComplete?.();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onChunk?.(data);
            } catch (e) {
              console.error('Failed to parse SSE data:', e);
            }
          }
        }
      }
    } catch (error) {
      onError?.(error);
      throw error;
    }
  },

  // ========== Analytics ==========
  getConversationStats: (conversationId) => 
    client.get(`/api/analytics/conversations/${conversationId}`),
  
  rateMessage: (messageId, rating) => 
    client.post(`/api/analytics/messages/${messageId}/rate`, { rating })
};

export default api;
