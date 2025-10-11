// modular-framework/modules/llm-workflows/server/__tests__/repoops.integration.test.js

const request = require('supertest');
const app = require('../app');

// Mock external services
jest.mock('axios');
const axios = require('axios');

describe('RepoOps Integration Tests', () => {
  const AUTH_TOKEN = 'supersecret';
  const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/repoops/plan', () => {
    it('should generate a valid plan', async () => {
      // Mock GitHub Hub responses
      axios.mockImplementation((config) => {
        const { url, method } = config;
        
        if (url.includes('/api/connections/') && method === 'GET') {
          return Promise.resolve({
            data: {
              connection: {
                id: 'test-repo',
                repo_url: 'https://github.com/test/repo.git',
                default_branch: 'main'
              }
            }
          });
        }
        
        if (url.includes('/api/tree') && method === 'GET') {
          return Promise.resolve({
            data: {
              items: [
                { path: 'src/index.ts', type: 'blob', size: 1024 },
                { path: 'src/api/health.ts', type: 'blob', size: 512 },
                { path: 'tests/health.test.ts', type: 'blob', size: 768 },
                { path: 'package.json', type: 'blob', size: 256 },
                { path: 'README.md', type: 'blob', size: 2048 }
              ]
            }
          });
        }
        
        if (url.includes('/api/file') && method === 'GET') {
          const fileName = config.params.path;
          const mockContent = {
            'package.json': '{"name":"test","version":"1.0.0"}',
            'README.md': '# Test Repo\n\nA test repository',
            'src/index.ts': 'export const app = express();',
            'src/api/health.ts': 'export const health = () => ({ ok: true });'
          };
          
          return Promise.resolve({
            data: {
              decoded_content: mockContent[fileName] || '',
              sha: 'abc123'
            }
          });
        }
        
        return Promise.reject(new Error('Unmocked request'));
      });

      // Mock LLM Gateway responses
      axios.post = jest.fn((url, data) => {
        if (url.includes('llm-workflows') || url.includes('llm-gateway')) {
          const isDiscovery = data.messages.some(m => 
            m.content?.includes('Repository tree')
          );
          
          if (isDiscovery) {
            // Phase 1: Discovery response
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  files: [
                    { path: 'src/api/health.ts', reason: 'existing health endpoint' },
                    { path: 'tests/health.test.ts', reason: 'tests to update' }
                  ],
                  created_files: [],
                  notes: 'Will modify existing health endpoint'
                })
              }
            });
          } else {
            // Phase 2: Proposal response
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  commit_message: 'feat(health): add version field',
                  changes: [
                    {
                      path: 'src/api/health.ts',
                      operation: 'update',
                      content: 'export const health = () => ({ ok: true, version: "1.0.0" });',
                      rationale: 'Added version field'
                    },
                    {
                      path: 'tests/health.test.ts',
                      operation: 'update',
                      content: 'test("version field", () => { expect(health().version).toBe("1.0.0"); });',
                      rationale: 'Added test for version field'
                    }
                  ],
                  tests: []
                })
              }
            });
          }
        }
        
        return Promise.reject(new Error('Unmocked POST'));
      });

      const response = await request(app)
        .post('/api/repoops/plan')
        .set(authHeaders)
        .send({
          conn_id: 'test-repo',
          base_branch: 'main',
          change_request: 'Add version field to health endpoint',
          allow_paths: ['src/**', 'tests/**'],
          llm_model: 'gpt-4o-mini'
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.discovery).toBeDefined();
      expect(response.body.discovery.files).toHaveLength(2);
      expect(response.body.proposed).toBeDefined();
      expect(response.body.proposed.changes).toHaveLength(2);
      expect(response.body.artifacts).toHaveLength(2);
    });

    it('should handle validation errors with retry', async () => {
      axios.mockImplementation(() => Promise.resolve({
        data: {
          connection: { id: 'test', repo_url: 'https://github.com/test/repo.git' }
        }
      }));

      let callCount = 0;
      axios.post = jest.fn(() => {
        callCount++;
        if (callCount === 1) {
          // First call: invalid JSON
          return Promise.resolve({
            data: { content: 'This is not JSON' }
          });
        }
        // Second call: valid JSON
        return Promise.resolve({
          data: {
            content: JSON.stringify({
              files: [{ path: 'src/index.ts', reason: 'main file' }],
              notes: 'Selected main file'
            })
          }
        });
      });

      const response = await request(app)
        .post('/api/repoops/plan')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          change_request: 'Test validation retry',
          llm_model: 'gpt-4o-mini'
        });

      expect(callCount).toBeGreaterThan(1);
    });

    it('should enforce path guardrails', async () => {
      axios.mockImplementation((config) => {
        if (config.url.includes('/api/tree')) {
          return Promise.resolve({
            data: {
              items: [
                { path: 'src/index.ts', type: 'blob', size: 1024 },
                { path: 'secrets/api-key.txt', type: 'blob', size: 64 },
                { path: 'dist/bundle.js', type: 'blob', size: 50000 }
              ]
            }
          });
        }
        return Promise.resolve({ data: {} });
      });

      axios.post = jest.fn(() => Promise.resolve({
        data: {
          content: JSON.stringify({
            files: [{ path: 'src/index.ts', reason: 'allowed' }],
            excluded_files: [
              { path: 'secrets/api-key.txt', reason: 'denied by policy' },
              { path: 'dist/bundle.js', reason: 'build artifact' }
            ]
          })
        }
      }));

      const response = await request(app)
        .post('/api/repoops/plan')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          change_request: 'Test guardrails',
          allow_paths: ['src/**', 'tests/**'],
          deny_paths: ['secrets/**', 'dist/**'],
          llm_model: 'gpt-4o-mini'
        });

      expect(response.status).toBe(200);
      expect(response.body.discovery.excluded_files).toBeDefined();
    });
  });

  describe('POST /api/repoops/apply', () => {
    it('should apply changes and create commit', async () => {
      axios.mockImplementation((config) => {
        const { url, method } = config;
        
        if (url.includes('/api/branch') && method === 'POST') {
          return Promise.resolve({ data: { ref: 'refs/heads/feature/test' } });
        }
        
        if (url.includes('/api/batch/commit') && method === 'POST') {
          return Promise.resolve({
            data: { commit_sha: 'abc123def456' }
          });
        }
        
        if (url.includes('/api/compare') && method === 'GET') {
          return Promise.resolve({
            data: {
              ahead_by: 1,
              behind_by: 0,
              total_commits: 1,
              files: [
                { filename: 'src/api/health.ts', status: 'modified' }
              ]
            }
          });
        }
        
        return Promise.resolve({ data: {} });
      });

      const plan = {
        commit_message: 'feat(health): add version',
        changes: [
          {
            path: 'src/api/health.ts',
            operation: 'update',
            content: 'export const health = () => ({ ok: true, version: "1.0.0" });',
            rationale: 'Added version'
          }
        ]
      };

      const response = await request(app)
        .post('/api/repoops/apply')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          head_branch: 'feature/test',
          plan,
          guardrails: {
            allowPaths: ['src/**'],
            maxChangedFiles: 10
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.commit_sha).toBe('abc123def456');
      expect(response.body.applied).toHaveLength(1);
    });

    it('should handle delete operations', async () => {
      axios.mockImplementation((config) => {
        if (config.method === 'GET' && config.url.includes('/api/file')) {
          return Promise.resolve({
            data: { sha: 'file-sha-123', decoded_content: 'old content' }
          });
        }
        
        if (config.method === 'DELETE' && config.url.includes('/api/file')) {
          return Promise.resolve({ data: { commit: { sha: 'delete-commit' } } });
        }
        
        return Promise.resolve({ data: {} });
      });

      const plan = {
        commit_message: 'chore: remove old file',
        changes: [
          {
            path: 'src/deprecated.ts',
            operation: 'delete',
            rationale: 'No longer needed'
          }
        ]
      };

      const response = await request(app)
        .post('/api/repoops/apply')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          head_branch: 'cleanup',
          plan
        });

      expect(response.status).toBe(200);
      expect(response.body.applied).toHaveLength(1);
    });
  });

  describe('POST /api/repoops/test', () => {
    it('should execute tests on runner', async () => {
      // Mock runner execution
      axios.post = jest.fn((url) => {
        if (url.includes('/agents/') && url.includes('/exec')) {
          return Promise.resolve({
            data: {
              ok: true,
              exitCode: 0,
              stdout: 'Tests passed!\n',
              stderr: '',
              killed: false
            }
          });
        }
        return Promise.reject(new Error('Unmocked'));
      });

      axios.get = jest.fn(() => Promise.resolve({
        data: {
          connection: {
            id: 'test',
            repo_url: 'https://github.com/test/repo.git'
          }
        }
      }));

      const response = await request(app)
        .post('/api/repoops/test')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          head_branch: 'feature/test',
          runner: 'lab',
          commands: ['npm ci', 'npm test']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.all_passed).toBe(true);
      expect(response.body.results).toBeDefined();
    });

    it('should handle test failures', async () => {
      axios.post = jest.fn(() => Promise.resolve({
        data: {
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: 'Test failed: expected true, got false',
          killed: false
        }
      }));

      axios.get = jest.fn(() => Promise.resolve({
        data: { connection: { repo_url: 'https://github.com/test/repo.git' } }
      }));

      const response = await request(app)
        .post('/api/repoops/test')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          head_branch: 'feature/broken',
          runner: 'lab',
          commands: ['npm test']
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(false);
      expect(response.body.all_passed).toBe(false);
    });
  });

  describe('POST /api/repoops/pr', () => {
    it('should create pull request', async () => {
      axios.post = jest.fn(() => Promise.resolve({
        data: {
          pull_request: {
            number: 42,
            html_url: 'https://github.com/test/repo/pull/42',
            title: 'feat: test PR'
          }
        }
      }));

      const response = await request(app)
        .post('/api/repoops/pr')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          head_branch: 'feature/test',
          title: 'feat: test PR',
          body: 'Test PR body',
          draft: false
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.pr.number).toBe(42);
      expect(response.body.pr.url).toContain('pull/42');
    });
  });

  describe('POST /api/repoops/run - Full Flow', () => {
    it('should execute complete workflow', async () => {
      // Mock all external calls
      axios.mockImplementation((config) => {
        const { url, method } = config;
        
        // GitHub Hub mocks
        if (url.includes('/connections')) {
          return Promise.resolve({
            data: { connection: { repo_url: 'https://github.com/test/repo.git' } }
          });
        }
        if (url.includes('/tree')) {
          return Promise.resolve({
            data: { items: [{ path: 'src/index.ts', type: 'blob', size: 1024 }] }
          });
        }
        if (url.includes('/file')) {
          return Promise.resolve({
            data: { decoded_content: 'content', sha: 'abc' }
          });
        }
        if (url.includes('/branch') && method === 'POST') {
          return Promise.resolve({ data: { ref: 'refs/heads/feature' } });
        }
        if (url.includes('/batch/commit')) {
          return Promise.resolve({ data: { commit_sha: 'commit123' } });
        }
        if (url.includes('/compare')) {
          return Promise.resolve({ data: { ahead_by: 1 } });
        }
        if (url.includes('/pr')) {
          return Promise.resolve({
            data: { pull_request: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }
          });
        }
        
        return Promise.resolve({ data: {} });
      });

      axios.post = jest.fn((url, data) => {
        // LLM Gateway
        if (url.includes('llm-workflows') || url.includes('llm-gateway')) {
          const isDiscovery = data?.messages?.some(m => m.content?.includes('Repository tree'));
          if (isDiscovery) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  files: [{ path: 'src/index.ts', reason: 'main' }]
                })
              }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                commit_message: 'feat: test',
                changes: [{
                  path: 'src/index.ts',
                  operation: 'update',
                  content: 'new content',
                  rationale: 'updated'
                }]
              })
            }
          });
        }
        
        // Runner Controller
        if (url.includes('/exec')) {
          return Promise.resolve({
            data: { ok: true, exitCode: 0, stdout: 'ok', stderr: '' }
          });
        }
        
        // GitHub Hub
        return axios(url, data);
      });

      const response = await request(app)
        .post('/api/repoops/run')
        .set(authHeaders)
        .send({
          conn_id: 'test',
          base_branch: 'main',
          change_request: 'Update index file',
          test: {
            enabled: true,
            runner: 'lab',
            commands: ['echo test']
          },
          open_pr: true
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.status).toBe('completed');
      expect(response.body.phases).toBeDefined();
      expect(response.body.phases.plan).toBeDefined();
      expect(response.body.phases.apply).toBeDefined();
      expect(response.body.phases.test).toBeDefined();
      expect(response.body.phases.pr).toBeDefined();
    });
  });
});