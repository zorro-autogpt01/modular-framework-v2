const fs = require('fs-extra');
const path = require('path');

class StagingManager {
  constructor({ stagingDir, reposDir, logger }) {
    this.stagingDir = stagingDir;
    this.reposDir = reposDir;
    this.logger = logger;
  }

  getJobStagingPath(jobId) {
    return path.join(this.stagingDir, `job-${jobId}`);
  }

  async prepareStaging(jobId, targetFiles) {
    const stagingPath = this.getJobStagingPath(jobId);
    
    // Clean up any existing staging for this job
    await fs.remove(stagingPath);
    await fs.ensureDir(stagingPath);
    
    // Copy target files from repos to staging
    for (const file of targetFiles) {
      const { connectionId, repoName, filePath } = file;
      const sourceFile = path.join(this.reposDir, connectionId, repoName, filePath);
      const destFile = path.join(stagingPath, connectionId, repoName, filePath);
      
      if (await fs.pathExists(sourceFile)) {
        await fs.ensureDir(path.dirname(destFile));
        await fs.copy(sourceFile, destFile);
        this.logger.info(`Copied ${sourceFile} to staging`);
      } else {
        this.logger.warn(`Source file not found: ${sourceFile}`);
        // Create empty file for new files
        await fs.ensureDir(path.dirname(destFile));
        await fs.writeFile(destFile, '');
      }
    }
    
    return stagingPath;
  }

  async getStagedFiles(jobId) {
    const stagingPath = this.getJobStagingPath(jobId);
    
    if (!await fs.pathExists(stagingPath)) {
      return [];
    }
    
    const files = [];
    
    async function walkDir(dir, baseDir = stagingPath) {
      const items = await fs.readdir(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);
        
        if (stat.isDirectory()) {
          await walkDir(fullPath, baseDir);
        } else {
          const relativePath = path.relative(baseDir, fullPath);
          files.push({
            path: relativePath,
            size: stat.size,
            modified: stat.mtime
          });
        }
      }
    }
    
    await walkDir(stagingPath);
    return files;
  }

  async getPreview(jobId) {
    const stagingPath = this.getJobStagingPath(jobId);
    const files = await this.getStagedFiles(jobId);
    const previews = [];
    
    for (const file of files) {
      const filePath = path.join(stagingPath, file.path);
      const content = await fs.readFile(filePath, 'utf8');
      
      // Get corresponding original file if it exists
      const parts = file.path.split(path.sep);
      if (parts.length >= 3) {
        const [connectionId, repoName, ...filePathParts] = parts;
        const originalPath = path.join(this.reposDir, connectionId, repoName, ...filePathParts);
        
        let originalContent = '';
        if (await fs.pathExists(originalPath)) {
          originalContent = await fs.readFile(originalPath, 'utf8');
        }
        
        previews.push({
          file: file.path,
          staged: content,
          original: originalContent,
          isNew: originalContent === ''
        });
      }
    }
    
    return previews;
  }

  async cleanup(jobId) {
    const stagingPath = this.getJobStagingPath(jobId);
    
    if (await fs.pathExists(stagingPath)) {
      await fs.remove(stagingPath);
      this.logger.info(`Cleaned up staging for job ${jobId}`);
    }
  }

  async getStatus() {
    const stagingDirExists = await fs.pathExists(this.stagingDir);
    
    if (!stagingDirExists) {
      return {
        available: false,
        path: this.stagingDir
      };
    }
    
    const dirs = await fs.readdir(this.stagingDir);
    const activeJobs = dirs.filter(d => d.startsWith('job-'));
    
    return {
      available: true,
      path: this.stagingDir,
      activeJobs: activeJobs.length,
      jobs: activeJobs.map(d => d.replace('job-', ''))
    };
  }

  async getFullStatus() {
    const status = await this.getStatus();
    
    if (status.available && status.jobs.length > 0) {
      const jobDetails = [];
      
      for (const jobId of status.jobs) {
        const files = await this.getStagedFiles(jobId);
        const stagingPath = this.getJobStagingPath(jobId);
        const stat = await fs.stat(stagingPath);
        
        jobDetails.push({
          jobId,
          path: stagingPath,
          fileCount: files.length,
          totalSize: files.reduce((sum, f) => sum + f.size, 0),
          created: stat.ctime,
          modified: stat.mtime
        });
      }
      
      status.jobDetails = jobDetails;
    }
    
    return status;
  }
}

module.exports = StagingManager;