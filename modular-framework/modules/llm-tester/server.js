import path from "node:path";
import fs from "node:fs";
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";

import testsRouter from "./src/routes/tests.js";
import suitesRouter from "./src/routes/suites.js";
import runsRouter from "./src/routes/runs.js";
import ciRouter from "./src/routes/ci.js";
import adminRouter from "./src/routes/admin.js";
import loggingRouter from "./src/routes/logging.js";
import logsRouter from "./src/routes/logs.js";
import { stamp, logInfo, logError } from "./src/logger.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
// Attach request id to each request
app.use(stamp);

// Lightweight http access logging for Splunk
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    logInfo('http_access', {
      rid: req.id,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      duration_ms: Math.round(durMs),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      ua: req.headers['user-agent'] || ''
    }, 'http');
  });
  next();
});


// Health
app.get("/api/health", (req, res) => res.json({ status: "healthy" }));
app.get("/api/v1/tester/health", (req, res) => res.json({ status: "healthy", version: "0.1.0" }));

// OpenAPI + Swagger UI
const openapiPath = path.join(process.cwd(), "openapi.llm-tester.yaml");
const openapiDoc = YAML.parse(fs.readFileSync(openapiPath, "utf8"));
app.get("/api/v1/tester/openapi.yaml", (req, res) => res.type("text/yaml").send(fs.readFileSync(openapiPath, "utf8")));
app.use("/api/v1/tester/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc, { explorer: true }));

// API routers (edge maps /api/v1/tester/* -> /api/* here)
app.use(["/api/tests", "/api/v1/tester/tests"], testsRouter);
app.use(["/api/suites", "/api/v1/tester/suites"], suitesRouter);
app.use(["/api/runs", "/api/v1/tester/runs"], runsRouter);
app.use(["/api/ci", "/api/v1/tester/ci"], ciRouter);
// Logging admin + buffer APIs
//app.use(["/api", "/api/llm-tester"], logsRouter);
//app.use(["/api", "/api/llm-tester"], loggingRouter);

app.use(["/api/admin", "/api/v1/tester/admin"], adminRouter);
app.use(["/api/logging", "/api/v1/tester/logging"], loggingRouter);
app.use(["/api/logs", "/api/v1/tester/logs"], logsRouter);

// Static Admin UI (edge maps /api/v1/tester/ -> /)
const uiDir = path.join(process.cwd(), "ui");
app.use(["/", "/llm-tester"], express.static(uiDir, { index: ["index.html"] }));

// Error handler
app.use((err, req, res, next) => {
  try {
    logError('unhandled_error', { rid: req?.id, message: err?.message || String(err), stack: err?.stack }, 'http');
  } catch {}
  res.status(500).json({ error: 'internal_error', message: err?.message || 'Unknown error' });
});


const PORT = process.env.PORT || 3040;
app.listen(PORT, () => {
  logInfo(`llm-tester-module listening on ${PORT}`, { port: PORT }, "startup");
  console.log(`llm-tester-module listening on ${PORT}`);
});
