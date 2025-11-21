const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

class JobQueueService {
  constructor({ dataDir, logger, redisPublisher }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.redisPublisher = redisPublisher;
    this.dbPath = path.join(dataDir, 'jobs.db');
    this.db = null;
  }

  async initialize() {
    await fs.ensureDir(this.dataDir);
    
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          this.logger.error('Error opening database:', err);
          reject(err);
        } else {
          this.logger.info('Database connected');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    const schema = `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        diff TEXT NOT NULL,
        targetFiles TEXT NOT NULL,
        source TEXT,
        options TEXT,
        error TEXT,
        stagingPath TEXT,
        appliedFiles TEXT,
        promotionResult TEXT,
        rejectionReason TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        startedAt DATETIME,
        stagedAt DATETIME,
        promotedAt DATETIME,
        rejectedAt DATETIME,
        failedAt DATETIME
      );
      
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_createdAt ON jobs(createdAt);
    `;

    return new Promise((resolve, reject) => {
      this.db.exec(schema, (err) => {
        if (err) {
          this.logger.error('Error creating tables:', err);
          reject(err);
        } else {
          this.logger.info('Database tables created');
          resolve();
        }
      });
    });
  }

  async createJob({ diff, targetFiles, source, options }) {
    const job = {
      id: uuidv4(),
      status: 'pending',
      diff,
      targetFiles: JSON.stringify(targetFiles),
      source: JSON.stringify(source),
      options: JSON.stringify(options),
      createdAt: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO jobs (id, status, diff, targetFiles, source, options, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      
      this.db.run(sql, [
        job.id, job.status, job.diff, job.targetFiles,
        job.source, job.options, job.createdAt
      ], (err) => {
        if (err) {
          this.logger.error('Error creating job:', err);
          reject(err);
        } else {
          // Return parsed version
          resolve({
            ...job,
            targetFiles: JSON.parse(job.targetFiles),
            source: JSON.parse(job.source),
            options: JSON.parse(job.options)
          });
        }
      });
    });
  }

  async getJob(jobId) {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM jobs WHERE id = ?';
      
      this.db.get(sql, [jobId], (err, row) => {
        if (err) {
          this.logger.error('Error fetching job:', err);
          reject(err);
        } else if (row) {
          // Parse JSON fields
          const job = { ...row };
          ['targetFiles', 'source', 'options', 'appliedFiles', 'promotionResult'].forEach(field => {
            if (job[field]) {
              try {
                job[field] = JSON.parse(job[field]);
              } catch (e) {
                this.logger.warn(`Failed to parse ${field} for job ${jobId}`);
              }
            }
          });
          resolve(job);
        } else {
          resolve(null);
        }
      });
    });
  }

  async getJobs({ status, limit, offset }) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM jobs';
      const params = [];
      
      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      
      sql += ' ORDER BY createdAt DESC';
      
      if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
      }
      
      if (offset) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
      
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          this.logger.error('Error fetching jobs:', err);
          reject(err);
        } else {
          // Parse JSON fields for each job
          const jobs = rows.map(row => {
            const job = { ...row };
            ['targetFiles', 'source', 'options', 'appliedFiles', 'promotionResult'].forEach(field => {
              if (job[field]) {
                try {
                  job[field] = JSON.parse(job[field]);
                } catch (e) {
                  this.logger.warn(`Failed to parse ${field} for job ${job.id}`);
                }
              }
            });
            return job;
          });
          resolve(jobs);
        }
      });
    });
  }

  async getJobCount({ status }) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT COUNT(*) as count FROM jobs';
      const params = [];
      
      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      
      this.db.get(sql, params, (err, row) => {
        if (err) {
          this.logger.error('Error counting jobs:', err);
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }

  async updateJob(jobId, updates) {
    const fields = [];
    const values = [];
    
    Object.entries(updates).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
        values.push(JSON.stringify(value));
      } else if (value instanceof Date) {
        values.push(value.toISOString());
      } else {
        values.push(value);
      }
    });
    
    values.push(jobId);
    
    return new Promise((resolve, reject) => {
      const sql = `UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`;
      
      this.db.run(sql, values, (err) => {
        if (err) {
          this.logger.error('Error updating job:', err);
          reject(err);
        } else {
          // Publish update to Redis
          if (this.redisPublisher) {
            this.redisPublisher.publish('diff-executor:job-updated', JSON.stringify({
              jobId,
              updates
            }));
          }
          resolve();
        }
      });
    });
  }

  getActiveJobCount() {
    return new Promise((resolve, reject) => {
      const sql = "SELECT COUNT(*) as count FROM jobs WHERE status IN ('pending', 'processing', 'staged')";
      
      this.db.get(sql, [], (err, row) => {
        if (err) {
          this.logger.error('Error counting active jobs:', err);
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }
}

module.exports = JobQueueService;