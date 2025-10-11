// modular-framework/modules/llm-workflows/server/routes/metrics.js
const express = require('express');
const router = express.Router();
const { getWorkflowStats, getWorkflowTimeline } = require('../db');
const { logInfo } = require('../logger');

router.get('/metrics/workflows/:id', async (req, res) => {
  const { id } = req.params;
  const { days = 30 } = req.query;
  
  logInfo('metrics_request', { workflow_id: id, days });
  
  try {
    const stats = getWorkflowStats(id, days);
    const timeline = getWorkflowTimeline(id, days);
    
    if (!stats) {
      return res.status(404).json({ error: 'Workflow not found or no data' });
    }
    
    const successRate = stats.total_runs > 0 
      ? ((stats.successful_runs / stats.total_runs) * 100).toFixed(2)
      : 0;
    
    res.json({
      workflow_id: id,
      period_days: days,
      stats: {
        ...stats,
        success_rate: successRate
      },
      timeline
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch metrics', detail: e.message });
  }
});

module.exports = { router };