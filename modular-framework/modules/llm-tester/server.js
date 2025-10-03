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

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/api/health", (req, res) => res.json({ status: "healthy" }));
app.get("/api/llm-tester/health", (req, res) => res.json({ status: "healthy", version: "0.1.0" }));

// OpenAPI + Swagger UI
const openapiPath = path.join(process.cwd(), "openapi.llm-tester.yaml");
const openapiDoc = YAML.parse(fs.readFileSync(openapiPath, "utf8"));
app.get("/api/llm-tester/openapi.yaml", (req, res) => res.type("text/yaml").send(fs.readFileSync(openapiPath, "utf8")));
app.use("/api/llm-tester/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc, { explorer: true }));

// API routers (edge maps /api/llm-tester/* -> /api/* here)
app.use(["/api/tests", "/api/llm-tester/tests"], testsRouter);
app.use(["/api/suites", "/api/llm-tester/suites"], suitesRouter);
app.use(["/api/runs", "/api/llm-tester/runs"], runsRouter);
app.use(["/api/ci", "/api/llm-tester/ci"], ciRouter);
app.use(["/api/admin", "/api/llm-tester/admin"], adminRouter);

// Static Admin UI (edge maps /llm-tester/ -> /)
const uiDir = path.join(process.cwd(), "ui");
app.use(["/", "/llm-tester"], express.static(uiDir, { index: ["index.html"] }));

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal_error", message: err?.message || "Unknown error" });
});

const PORT = process.env.PORT || 3040;
app.listen(PORT, () => console.log(`llm-tester-module listening on ${PORT}`));
