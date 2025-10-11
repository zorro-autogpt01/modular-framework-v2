// modular-framework/modules/llm-workflows/server/schemas/repoops.js

/**
 * Schema for file discovery phase (Phase 1)
 * Identifies relevant files to examine for the change request
 */
const RELEVANT_FILES_V1 = {
  type: 'object',
  required: ['files', 'reasoning'],
  properties: {
    files: {
      type: 'array',
      description: 'List of existing files that need to be examined or modified',
      items: {
        type: 'object',
        required: ['path', 'relevance'],
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from repository root'
          },
          relevance: {
            type: 'string',
            description: 'Why this file is relevant to the change request',
            enum: ['direct_change', 'related_logic', 'test_coverage', 'configuration', 'documentation']
          },
          notes: {
            type: 'string',
            description: 'Optional notes about what to look for in this file'
          }
        }
      },
      maxItems: 20
    },
    created_files: {
      type: 'array',
      description: 'List of new files that may need to be created',
      items: {
        type: 'object',
        required: ['path', 'purpose'],
        properties: {
          path: {
            type: 'string',
            description: 'Relative path where the new file should be created'
          },
          purpose: {
            type: 'string',
            description: 'Purpose of the new file'
          },
          file_type: {
            type: 'string',
            description: 'Type of file (e.g., source, test, config, documentation)'
          }
        }
      },
      maxItems: 10
    },
    reasoning: {
      type: 'string',
      description: 'Overall reasoning for the file selection strategy',
      minLength: 10,
      maxLength: 2000
    },
    estimated_scope: {
      type: 'string',
      description: 'Estimated scope of changes',
      enum: ['small', 'medium', 'large']
    }
  },
  additionalProperties: false
};

/**
 * Schema for code changes phase (Phase 2)
 * Proposes specific changes to files
 */
const CODE_CHANGES_V1 = {
  type: 'object',
  required: ['changes', 'commit_message', 'summary'],
  properties: {
    changes: {
      type: 'array',
      description: 'List of file changes to apply',
      items: {
        type: 'object',
        required: ['path', 'operation'],
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file from repository root'
          },
          operation: {
            type: 'string',
            description: 'Type of operation to perform',
            enum: ['create', 'update', 'delete']
          },
          content: {
            type: 'string',
            description: 'Complete file content for create/update operations. Must be full file, not a patch.'
          },
          rationale: {
            type: 'string',
            description: 'Explanation of why this change is needed',
            minLength: 10,
            maxLength: 500
          }
        },
        allOf: [
          {
            if: {
              properties: { operation: { enum: ['create', 'update'] } }
            },
            then: {
              required: ['content']
            }
          }
        ]
      },
      minItems: 1,
      maxItems: 50
    },
    tests: {
      type: 'array',
      description: 'Test files included in the changes',
      items: {
        type: 'object',
        required: ['path', 'coverage'],
        properties: {
          path: {
            type: 'string',
            description: 'Path to the test file'
          },
          coverage: {
            type: 'string',
            description: 'What this test covers'
          },
          test_type: {
            type: 'string',
            description: 'Type of test',
            enum: ['unit', 'integration', 'e2e', 'other']
          }
        }
      }
    },
    commit_message: {
      type: 'string',
      description: 'Commit message for the changes. Should follow conventional commits format.',
      minLength: 10,
      maxLength: 500,
      pattern: '^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\\(.+\\))?: .+'
    },
    summary: {
      type: 'string',
      description: 'High-level summary of all changes made',
      minLength: 20,
      maxLength: 2000
    },
    breaking_changes: {
      type: 'boolean',
      description: 'Whether these changes include breaking changes',
      default: false
    },
    dependencies_added: {
      type: 'array',
      description: 'List of new dependencies added',
      items: {
        type: 'string'
      }
    },
    migration_notes: {
      type: 'string',
      description: 'Notes for migrating existing code if there are breaking changes',
      maxLength: 2000
    },
    test_commands: {
      type: 'array',
      description: 'Commands to run to test the changes',
      items: {
        type: 'string',
        description: 'Shell command to execute'
      },
      examples: [
        ['npm test', 'npm run lint'],
        ['pytest tests/', 'python -m mypy .'],
        ['make test']
      ]
    }
  },
  additionalProperties: false
};

module.exports = {
  RELEVANT_FILES_V1,
  CODE_CHANGES_V1
};