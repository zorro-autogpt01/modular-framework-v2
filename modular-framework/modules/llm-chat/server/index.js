const app = require('./app');
const { logInfo } = require('./logger');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  logInfo('llm-chat:listen', { port: Number(PORT), log_level: LOG_LEVEL, ts: new Date().toISOString() });
});
