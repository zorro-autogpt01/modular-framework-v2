const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const WebSocket = require('ws');
const redis = require('redis');
const winston = require('winston');
require('dotenv').config();

// Import services
const JobQueueService = require('./services/job-queue');
const DiffApplicator = require('./services/diff-applicator');
const StagingManager = require('./services/staging-manager');
const IntegrationService = require('./services/integration');

// Setup logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const PORT = process.env.PORT || 3045;
const STAGING_DIR = process.env.STAGING_DIR || '/workspace/diff-staging';
const REPOS_DIR = '/workspace/repos';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CODE_WORKSPACE_URL = process.env.CODE_WORKSPACE_URL || 'http://code-workspace:3006';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// Initialize services
let redisClient, redisPublisher;
let jobQueue, diffApplicator, stagingManager, integrationService;
const wsClients = new Set();

async function initRedis() {
  redisClient = redis.createClient({ url: REDIS_URL });
  redisPublisher = redis.createClient({ url: REDIS_URL });
  
  redisClient.on('error', (err) => logger.error('Redis Client Error', err));
  redisPublisher.on('error', (err) => logger.error('Redis Publisher Error', err));
  
  await redisClient.connect();
  await redisPublisher.connect();
  logger.info('Redis connected successfully');
}

async function initServices() {
  await fs.ensureDir(STAGING_DIR);
  await fs.ensureDir(DATA_DIR);
  
  jobQueue = new JobQueueService({ dataDir: DATA_DIR, logger, redisPublisher });
  stagingManager = new StagingManager({ stagingDir: STAGING_DIR, reposDir: REPOS_DIR, logger });
  diffApplicator = new DiffApplicator({ stagingManager, logger });
  integrationService = new IntegrationService({ codeWorkspaceUrl: CODE_WORKSPACE_URL, redisPublisher, logger });
  
  await jobQueue.initialize();
  logger.info('Services initialized');
}

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// WebSocket handling
wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.info('New WebSocket client connected');
  
  ws.send(JSON.stringify({
    type: 'connected',
    data: {
      jobCount: jobQueue ? jobQueue.getActiveJobCount() : 0,
      stagingStatus: stagingManager ? stagingManager.getStatus() : {}
    }
  }));
  
  ws.on('close', () => {
    wsClients.delete(ws);
    logger.info('WebSocket client disconnected');
  });
});

function broadcast(message) {
  const data = JSON.stringify(message);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    staging: {
      path: STAGING_DIR,
      writable: fs.existsSync(STAGING_DIR),
      activeJobs: jobQueue ? jobQueue.getActiveJobCount() : 0
    },
    integrations: {
      codeWorkspace: CODE_WORKSPACE_URL ? 'configured' : 'not configured',
      redis: redisClient && redisClient.isOpen ? 'connected' : 'disconnected'
    }
  });
});

app.post('/api/jobs', async (req, res) => {
  try {
    const { diff, targetFiles, source, options } = req.body;
    
    if (!diff || !targetFiles) {
      return res.status(400).json({ error: 'Missing required fields: diff and targetFiles' });
    }
    
    const job = await jobQueue.createJob({
      diff,
      targetFiles,
      source: source || { type: 'api', user: 'unknown' },
      options: options || {}
    });
    
    processJob(job.id);
    broadcast({ type: 'job:created', data: job });
    
    res.json({ success: true, job });
  } catch (error) {
    logger.error('Error creating job:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const jobs = await jobQueue.getJobs({ status, limit, offset });
    
    res.json({
      jobs,
      total: await jobQueue.getJobCount({ status }),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    logger.error('Error fetching jobs:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    const job = await jobQueue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status === 'staged') {
      job.stagedFiles = await stagingManager.getStagedFiles(job.id);
    }
    
    res.json(job);
  } catch (error) {
    logger.error('Error fetching job:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/jobs/:jobId/preview', async (req, res) => {
  try {
    const job = await jobQueue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'staged') {
      return res.status(400).json({ error: 'Job is not staged' });
    }
    
    const preview = await stagingManager.getPreview(job.id);
    res.json(preview);
  } catch (error) {
    logger.error('Error getting preview:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:jobId/promote', async (req, res) => {
  try {
    const job = await jobQueue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    if (job.status !== 'staged') {
      return res.status(400).json({ error: `Cannot promote job in ${job.status} status` });
    }
    
    const { repoId, connectionId, createSnapshot = true } = req.body;
    
    if (!repoId || !connectionId) {
      return res.status(400).json({ error: 'Missing required fields: repoId and connectionId' });
    }
    
    const result = await integrationService.promoteToWorkspace({
      jobId: job.id,
      repoId,
      connectionId,
      stagingPath: stagingManager.getJobStagingPath(job.id),
      files: job.targetFiles,
      source: job.source,
      createSnapshot
    });
    
    if (result.success) {
      await jobQueue.updateJob(job.id, {
        status: 'promoted',
        promotedAt: new Date(),
        promotionResult: result
      });
      
      await stagingManager.cleanup(job.id);
      broadcast({ type: 'job:promoted', data: { jobId: job.id, result } });
      
      res.json({ success: true, message: 'Changes promoted successfully', result });
    } else {
      throw new Error(result.error || 'Promotion failed');
    }
  } catch (error) {
    logger.error('Error promoting job:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:jobId/reject', async (req, res) => {
  try {
    const job = await jobQueue.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const { reason } = req.body;
    
    if (job.status === 'staged') {
      await stagingManager.cleanup(job.id);
    }
    
    await jobQueue.updateJob(job.id, {
      status: 'rejected',
      rejectedAt: new Date(),
      rejectionReason: reason
    });
    
    broadcast({ type: 'job:rejected', data: { jobId: job.id, reason } });
    res.json({ success: true, message: 'Job rejected' });
  } catch (error) {
    logger.error('Error rejecting job:', error);
    res.status(500).json({ error: error.message });
  }
});

// Job processing function
async function processJob(jobId) {
  try {
    logger.info(`Processing job ${jobId}`);
    const job = await jobQueue.getJob(jobId);
    
    await jobQueue.updateJob(jobId, { status: 'processing', startedAt: new Date() });
    broadcast({ type: 'job:processing', data: { jobId } });
    
    const stagingPath = await stagingManager.prepareStaging(jobId, job.targetFiles);
    const result = await diffApplicator.applyDiff(job.diff, job.targetFiles, stagingPath);
    
    if (result.success) {
      await jobQueue.updateJob(jobId, {
        status: 'staged',
        stagedAt: new Date(),
        stagingPath,
        appliedFiles: result.appliedFiles
      });
      
      broadcast({ type: 'job:staged', data: { jobId, files: result.appliedFiles } });
    } else {
      await jobQueue.updateJob(jobId, {
        status: 'failed',
        failedAt: new Date(),
        error: result.error
      });
      
      await stagingManager.cleanup(jobId);
      broadcast({ type: 'job:failed', data: { jobId, error: result.error } });
    }
  } catch (error) {
    logger.error(`Error processing job ${jobId}:`, error);
    await jobQueue.updateJob(jobId, {
      status: 'failed',
      failedAt: new Date(),
      error: error.message
    });
    broadcast({ type: 'job:failed', data: { jobId, error: error.message } });
  }
}

// Serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start server
async function start() {
  try {
    await initRedis();
    await initServices();
    
    server.listen(PORT, () => {
      logger.info(`Diff Executor server running on port ${PORT}`);
      logger.info(`Staging directory: ${STAGING_DIR}`);
      logger.info(`Code Workspace URL: ${CODE_WORKSPACE_URL}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => logger.info('HTTP server closed'));
  if (redisClient) await redisClient.quit();
  if (redisPublisher) await redisPublisher.quit();
  process.exit(0);
});

start();