const app = require('./app');

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
  console.log(`LLM Chat Module listening on :${PORT} (LOG_LEVEL=${LOG_LEVEL})`);
});
