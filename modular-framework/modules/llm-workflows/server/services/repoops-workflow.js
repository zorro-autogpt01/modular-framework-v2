// modular-framework/modules/llm-workflows/server/services/repoops-workflow.js
// Integration for using RepoOps as a workflow step

const {
  runDiscovery,
  runProposal,
  applyChanges,
  runTests,
  createPR
} = require('./repoops');
const { renderTemplate } = require('./template-helpers');

/**
 * Execute a RepoOps step within a workflow
 * 
 * Step schema:
 * {
 *   kind: 'repoops',
 *   conn_id: 'core-repo',
 *   base_branch: 'main',
 *   head_branch: 'feature/{{feature_name}}',  // supports templating
 *   change_request: '{{task}}',               // supports templating
 *   allow_paths: ['src/**', 'tests/**'],
 *   deny_paths: ['**\/*.png'],
 *   language_hints: ['ts', 'tsx'],
 *   llm_model: 'gpt-4o-mini',
 *   temperature: 0.2,
 *   test: {
 *     enabled: true,
 *     runner: 'lab',
 *     commands: ['npm ci', 'npm test'],
 *     timeoutMs: 900000
 *   },
 *   open_pr: true,
 *   pr_draft: false,
 *   require_approval: false,
 *   export_pr_url_as: 'pr_url',          // export PR URL to this var
 *   export_head_branch_as: 'feature_branch'
 * }
 */
async function executeRepoOpsStep({ step, vars, runContext }) {
  const {
    conn_id,
    base_branch = 'main',
    head_branch,
    change_request,
    allow_paths,
    deny_paths,
    language_hints,
    llm_model = 'gpt-4o-mini',
    temperature = 0.2,
    test = {},
    open_pr = false,
    pr_draft = false,
    require_approval = false,
    export_pr_url_as,
    export_head_branch_as
  } = step;

  const corr = runContext.correlationId || `wf_${Date.now()}`;
  const logs = [];
  const artifacts = [];

  function log(level, msg, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      step: step.name || step.id,
      ...meta
    };
    logs.push(entry);
    runContext.log?.(level, msg, meta);
  }

  try {
    // Render templated values
    const effectiveChangeRequest = renderTemplate(change_request || '', vars);
    const effectiveHeadBranch = head_branch 
      ? renderTemplate(head_branch, vars)
      : `repoops/${Date.now()}`;

    log('info', 'RepoOps step started', {
      conn_id,
      base_branch,
      head_branch: effectiveHeadBranch,
      model: llm_model
    });

    // Phase 1: Discovery
    log('info', 'Running file discovery');
    const discoveryResult = await runDiscovery({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: effectiveChangeRequest,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      languageHints: language_hints,
      model: llm_model,
      temperature,
      corr
    });

    artifacts.push({
      type: 'repoops.discovery',
      step: step.name || step.id,
      content: JSON.stringify(discoveryResult.discovery, null, 2)
    });

    log('info', 'Discovery complete', {
      files_selected: discoveryResult.discovery.files?.length || 0
    });

    // Phase 2: Proposal
    log('info', 'Generating change proposal');
    const proposalResult = await runProposal({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: effectiveChangeRequest,
      discovery: discoveryResult.discovery,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      model: llm_model,
      temperature,
      corr
    });

    artifacts.push({
      type: 'repoops.proposal',
      step: step.name || step.id,
      content: JSON.stringify(proposalResult.proposed, null, 2)
    });

    log('info', 'Proposal complete', {
      changes_count: proposalResult.proposed.changes?.length || 0
    });

    // Approval gate
    if (require_approval) {
      log('info', 'Approval required - pausing workflow');
      return {
        ok: true,
        status: 'pending_approval',
        logs,
        artifacts,
        data: {
          discovery: discoveryResult.discovery,
          proposal: proposalResult.proposed,
          head_branch: effectiveHeadBranch
        },
        message: 'Workflow paused. Review plan and manually approve to continue.'
      };
    }

    // Phase 3: Apply
    log('info', 'Applying changes');
    const applyResult = await applyChanges({
      connId: conn_id,
      baseBranch: base_branch,
      headBranch: effectiveHeadBranch,
      plan: proposalResult.proposed,
      guardrails: {
        allowPaths: allow_paths,
        denyPaths: deny_paths,
        maxChangedFiles: 50,
        maxTotalKB: 512
      },
      corr
    });

    artifacts.push({
      type: 'repoops.diff',
      step: step.name || step.id,
      content: JSON.stringify({
        commit_sha: applyResult.commit_sha,
        applied: applyResult.applied,
        skipped: applyResult.skipped
      }, null, 2)
    });

    log('info', 'Changes applied', {
      commit_sha: applyResult.commit_sha,
      files_changed: applyResult.applied.length
    });

    // Phase 4: Test
    if (test.enabled && test.runner && test.commands?.length) {
      log('info', 'Running tests on runner', { runner: test.runner });
      
      const testResult = await runTests({
        connId: conn_id,
        headBranch: effectiveHeadBranch,
        runner: test.runner,
        commands: test.commands,
        timeoutMs: test.timeoutMs,
        corr
      });

      const testLog = testResult.results.map(r => 
        `Command: ${r.cmd}\nExit: ${r.exitCode}\n${r.stdout || ''}\n${r.stderr || ''}`
      ).join('\n---\n');

      artifacts.push({
        type: 'repoops.test_log',
        step: step.name || step.id,
        content: testLog
      });

      log('info', 'Tests complete', { all_passed: testResult.ok });

      if (!testResult.ok) {
        log('error', 'Tests failed');
        return {
          ok: false,
          status: 'tests_failed',
          logs,
          artifacts,
          data: {
            test_results: testResult.results,
            head_branch: effectiveHeadBranch
          },
          error: 'Tests failed. See artifacts for details.'
        };
      }
    }

    // Phase 5: PR
    let prUrl = null;
    if (open_pr) {
      log('info', 'Creating pull request');
      
      const prTitle = proposalResult.proposed.commit_message || 'feat: automated changes';
      const prBody = [
        '## Automated Changes',
        effectiveChangeRequest,
        '',
        `**Commit:** ${applyResult.commit_sha}`,
        `**Files changed:** ${applyResult.applied.length}`,
        '',
        test.enabled ? `**Tests:** ${test.enabled ? '✅ Passed' : 'Skipped'}` : '',
        '',
        '---',
        '*Generated by RepoOps workflow*'
      ].join('\n');

      const prResult = await createPR({
        connId: conn_id,
        baseBranch: base_branch,
        headBranch: effectiveHeadBranch,
        title: prTitle,
        body: prBody,
        draft: pr_draft,
        corr
      });

      prUrl = prResult.pr.url;

      artifacts.push({
        type: 'repoops.pr',
        step: step.name || step.id,
        content: JSON.stringify({
          number: prResult.pr.number,
          url: prResult.pr.url,
          title: prResult.pr.title
        }, null, 2)
      });

      log('info', 'Pull request created', {
        pr_number: prResult.pr.number,
        pr_url: prUrl
      });
    }

    // Export variables
    const exports = {};
    if (export_pr_url_as && prUrl) {
      exports[export_pr_url_as] = prUrl;
    }
    if (export_head_branch_as) {
      exports[export_head_branch_as] = effectiveHeadBranch;
    }

    log('info', 'RepoOps step completed');

    return {
      ok: true,
      status: 'completed',
      logs,
      artifacts,
      data: {
        commit_sha: applyResult.commit_sha,
        head_branch: effectiveHeadBranch,
        pr_url: prUrl,
        files_changed: applyResult.applied.length
      },
      exports
    };

  } catch (error) {
    log('error', 'RepoOps step failed', { error: error.message });
    
    return {
      ok: false,
      status: 'error',
      logs,
      artifacts,
      error: error.message || 'RepoOps step failed'
    };
  }
}

/**
 * Add to workflows server app.js:
 * 
 * In the workflow execution loop where you handle steps, add:
 * 
 * if (step.kind === 'repoops') {
 *   const repoOpsResult = await executeRepoOpsStep({
 *     step,
 *     vars,
 *     runContext: {
 *       correlationId: run.id,
 *       log: (level, msg, meta) => {
 *         run.logs.push({ ts: new Date().toISOString(), level, msg, step: step.name, ...meta });
 *       }
 *     }
 *   });
 * 
 *   run.logs.push(...repoOpsResult.logs);
 *   run.artifacts.push(...repoOpsResult.artifacts);
 * 
 *   if (repoOpsResult.exports) {
 *     Object.assign(vars, repoOpsResult.exports);
 *   }
 * 
 *   if (!repoOpsResult.ok) {
 *     if (step.stopOnFailure !== false) {
 *       run.status = 'failed';
 *       return res.json(run);
 *     }
 *   }
 * 
 *   if (repoOpsResult.status === 'pending_approval') {
 *     run.status = 'pending_approval';
 *     return res.json(run);
 *   }
 * 
 *   continue; // next step
 * }
 */

module.exports = {
  executeRepoOpsStep
};