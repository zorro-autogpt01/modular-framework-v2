const app = require('./app');
const PORT = Number(process.env.PORT || 4015);
app.listen(PORT, () => {
  console.log(`llm-runner-controller listening on :${PORT}`);
});
