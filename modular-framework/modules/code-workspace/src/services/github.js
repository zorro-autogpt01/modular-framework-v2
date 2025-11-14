const axios = require('axios');

class GitHubService {
  constructor() {
    // ✅ FIXED: Include /api in the base URL
    this.githubHubUrl = process.env.GITHUB_HUB_URL || 'http://github-hub-module:3002/api';
  }

  /**
   * Get authenticated clone URL for a connection
   * Returns the clone URL with embedded authentication token
   */
  async getConnectionCredentials(connection_id) {
    try {
      // ✅ FIXED: Use the /clone_url endpoint
      const url = `${this.githubHubUrl}/connections/${connection_id}/clone_url`;
      console.log('Fetching clone URL from:', url);
      
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data && response.data.clone_url) {
        console.log(`✅ Got authenticated clone URL for ${connection_id}`);
        return response.data.clone_url; // Returns string like: https://token@github.com/owner/repo
      }
      
      console.warn(`⚠️ No clone_url in response for ${connection_id}`);
      return null;
    } catch (error) {
      console.error(`❌ Error getting credentials for ${connection_id}:`, error.message);
      return null;
    }
  }

  /**
   * Get connection details (metadata only, not for cloning)
   */
  async getConnection(connection_id) {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/connections/${connection_id}`,
        { timeout: 5000 }
      );

      return response.data;
    } catch (error) {
      console.error(`Error getting connection ${connection_id}:`, error.message);
      return null;
    }
  }

  async getConnections() {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/connections`,
        { timeout: 5000 }
      );

      return response.data.connections || [];
    } catch (error) {
      console.error('Error getting connections:', error.message);
      return [];
    }
  }

  async getRepositories(connection_id) {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/repos/${connection_id}`,
        { timeout: 10000 }
      );

      return response.data.repos || [];
    } catch (error) {
      console.error(`Error getting repositories for ${connection_id}:`, error.message);
      return [];
    }
  }

  async getRepoDetails(connection_id, owner, repo) {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/repos/${connection_id}/${owner}/${repo}`,
        { timeout: 10000 }
      );

      return response.data;
    } catch (error) {
      console.error(`Error getting repo details for ${owner}/${repo}:`, error.message);
      return null;
    }
  }

  async createPullRequest(connection_id, owner, repo, data) {
    try {
      const response = await axios.post(
        `${this.githubHubUrl}/pulls/${connection_id}/${owner}/${repo}`,
        data,
        { timeout: 10000 }
      );

      return response.data;
    } catch (error) {
      console.error('Error creating pull request:', error.message);
      throw error;
    }
  }

  async getBranches(connection_id, owner, repo) {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/branches/${connection_id}/${owner}/${repo}`,
        { timeout: 10000 }
      );

      return response.data.branches || [];
    } catch (error) {
      console.error(`Error getting branches for ${owner}/${repo}:`, error.message);
      return [];
    }
  }

  async getFileContent(connection_id, owner, repo, path, branch = 'main') {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/files/${connection_id}/${owner}/${repo}/${path}`,
        {
          params: { branch },
          timeout: 10000
        }
      );

      return response.data;
    } catch (error) {
      console.error(`Error getting file content for ${owner}/${repo}/${path}:`, error.message);
      return null;
    }
  }

  async checkHealth() {
    try {
      const response = await axios.get(
        `${this.githubHubUrl}/health`,
        { timeout: 5000 }
      );

      return response.data;
    } catch (error) {
      console.error('GitHub Hub health check failed:', error.message);
      return { status: 'unhealthy', error: error.message };
    }
  }
}

module.exports = new GitHubService();