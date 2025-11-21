const axios = require('axios');

class IntegrationService {
  constructor({ codeWorkspaceUrl, redisPublisher, logger }) {
    this.codeWorkspaceUrl = codeWorkspaceUrl;
    this.redisPublisher = redisPublisher;
    this.logger = logger;
  }

  async promoteToWorkspace({ jobId, repoId, connectionId, stagingPath, files, source, createSnapshot }) {
    try {
      // Call code-workspace API to promote files from staging
      const response = await axios.post(
        `${this.codeWorkspaceUrl}/api/workspace/promote-from-staging`,
        {
          repoId,
          connectionId,
          stagingPath,
          files,
          source: {
            type: 'diff-executor',
            jobId,
            ...source
          },
          createSnapshot
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000 // 30 second timeout
        }
      );

      // Publish Redis event for file-watcher
      if (this.redisPublisher) {
        await this.redisPublisher.publish('repo:changes', JSON.stringify({
          type: 'diff-promotion',
          repoId,
          connectionId,
          files: files.map(f => f.filePath),
          source: {
            service: 'diff-executor',
            jobId
          },
          snapshotId: response.data.snapshotId,
          timestamp: Date.now()
        }));
      }

      return response.data;
    } catch (error) {
      this.logger.error('Error promoting to workspace:', error.message);
      
      if (error.response) {
        return {
          success: false,
          error: error.response.data.error || error.response.statusText
        };
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  async checkWorkspaceHealth() {
    try {
      const response = await axios.get(
        `${this.codeWorkspaceUrl}/api/health`,
        { timeout: 5000 }
      );
      
      return response.data;
    } catch (error) {
      this.logger.error('Code-workspace health check failed:', error.message);
      return null;
    }
  }
}

module.exports = IntegrationService;