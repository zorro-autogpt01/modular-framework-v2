// modular-framework/modules/llm-workflows/server/notifications.js
const axios = require('axios');
const { logInfo, logWarn, logError } = require('./logger');

class NotificationService {
  constructor() {
    this.config = this._loadConfig();
  }
  
  _loadConfig() {
    try {
      const configStr = process.env.NOTIFICATION_CONFIG;
      return configStr ? JSON.parse(configStr) : null;
    } catch (e) {
      logWarn('notification_config_invalid', { error: e.message });
      return null;
    }
  }
  
  async send({ type, workflow, run, message }) {
    if (!this.config) {
      logInfo('notifications_disabled', { type });
      return;
    }
    
    const promises = [];
    
    if (this.config.slack?.webhook) {
      promises.push(this.sendSlack(this.config.slack.webhook, {
        text: `*${workflow.name}*`,
        attachments: [{
          color: run.status === 'ok' ? 'good' : run.status === 'failed' ? 'danger' : 'warning',
          fields: [
            { title: 'Status', value: run.status.toUpperCase(), short: true },
            { title: 'Duration', value: this.formatDuration(run), short: true },
            { title: 'Run ID', value: run.id, short: false },
            { title: 'Message', value: message || 'No details', short: false }
          ],
          footer: 'LLM Workflows',
          ts: Math.floor(new Date(run.startedAt).getTime() / 1000)
        }]
      }));
    }
    
    if (this.config.webhook?.url) {
      promises.push(this.sendWebhook(this.config.webhook.url, {
        event: type,
        workflow: { 
          id: workflow.id, 
          name: workflow.name 
        },
        run: { 
          id: run.id, 
          status: run.status,
          started_at: run.startedAt,
          finished_at: run.finishedAt
        },
        message
      }, this.config.webhook.headers || {}));
    }
    
    await Promise.allSettled(promises);
  }
  
  async sendSlack(webhook, payload) {
    try {
      await axios.post(webhook, payload, { timeout: 5000 });
      logInfo('slack_notification_sent');
    } catch (e) {
      logWarn('slack_notification_failed', { error: e.message });
    }
  }
  
  async sendWebhook(url, payload, headers) {
    try {
      await axios.post(url, payload, { 
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        timeout: 5000 
      });
      logInfo('webhook_notification_sent', { url });
    } catch (e) {
      logWarn('webhook_notification_failed', { url, error: e.message });
    }
  }
  
  formatDuration(run) {
    if (!run.finishedAt) return 'Running...';
    const ms = new Date(run.finishedAt) - new Date(run.startedAt);
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}

module.exports = new NotificationService();