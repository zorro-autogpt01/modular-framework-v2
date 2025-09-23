const app = require('./app');
const { logInfo } = require('./logger');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();



const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`LLM Chat Module listening on :${PORT} (LOG_LEVEL=${LOG_LEVEL})`);
  
  // Test Splunk logging
  logInfo('LLM Chat module started', { port: PORT, timestamp: new Date().toISOString() });
});