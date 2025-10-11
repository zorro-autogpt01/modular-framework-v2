// modular-framework/modules/llm-workflows/server/routes/repoops.js

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  runDiscovery,
  runProposal,
  applyChanges,
  runTests,
  createPR
} = require('../services/repoops');
const { logInfo, logError, logWarn } = require('../logger');

function uuid() {
  return crypto.randomUUID();
}

// In-memory job status store (consider moving to database for production)
const jobStore = new Map();

function updateJobStatus(jobId, updates) {
  const job = jobStore.get(jobId) || {};
  const updated = { ...job, ...updates, updated_at: new Date().toISOString() };
  jobStore.set(jobId, updated);
  return updated;
}

function getJobStatus(jobId) {
  return jobStore.get(jobId) || null;
}

/**
 * POST /api/repoops/plan
 * Runs Phase 1 (discovery) and Phase 2 (change proposal)
 */
router.post('/plan', async (req, res) => {
  const corr = `plan_${uuid()}`;
  const {
    conn_id,
    base_branch = 'main',
    change_request,
    allow_paths,
    deny_paths,
    max_files,
    max_file_kb,
    language_hints,
    llm_model = 'gpt-4o-mini',
    temperature = 0.2
  } = req.body || {};

  if (!conn_id || !change_request) {
    return res.status(400).json({ 
      ok: false, 
      error: 'conn_id and change_request are required' 
    });
  }

  try {
    logInfo('repoops_plan_request', { 
      corr, 
      conn_id, 
      base_branch, 
      model: llm_model,
      changeRequestLen: change_request.length 
    });

    // Phase 1: Discovery
    const discoveryResult = await runDiscovery({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      languageHints: language_hints,
      model: llm_model,
      temperature,
      corr
    });

    // Phase 2: Proposal
    const proposalResult = await runProposal({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      discovery: discoveryResult.discovery,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      model: llm_model,
      temperature,
      corr
    });

    const response = {
      ok: true,
      correlation_id: corr,
      discovery: discoveryResult.discovery,
      proposed: proposalResult.proposed,
      budget: {
        ...proposalResult.budget,
        candidates_scanned: discoveryResult.candidates,
        context_files: discoveryResult.contextFiles,
        files_included: proposalResult.budget.files_fetched
      },
      artifacts: [
        {
          type: 'plan.discovery',
          content: JSON.stringify(discoveryResult.discovery, null, 2),
          size: Buffer.byteLength(discoveryResult.raw, 'utf8')
        },
        {
          type: 'plan.proposal',
          content: JSON.stringify(proposalResult.proposed, null, 2),
          size: Buffer.byteLength(proposalResult.raw, 'utf8')
        }
      ]
    };

    logInfo('repoops_plan_success', { 
      corr, 
      filesSelected: discoveryResult.discovery.files?.length || 0,
      changesProposed: proposalResult.proposed.changes?.length || 0
    });

    res.json(response);
  } catch (e) {
    logError('repoops_plan_failed', { corr, error: e.message, stack: e.stack });
    res.status(500).json({ 
      ok: false, 
      correlation_id: corr,
      error: e.message || 'Plan failed' 
    });
  }
});

/**
 * POST /api/repoops/apply
 * Applies a validated code_changes.v1 plan
 */
router.post('/apply', async (req, res) => {
  const corr = `apply_${uuid()}`;
  const {
    conn_id,
    base_branch = 'main',
    head_branch,
    plan,
    guardrails
  } = req.body || {};

  if (!conn_id || !head_branch || !plan) {
    return res.status(400).json({ 
      ok: false, 
      error: 'conn_id, head_branch, and plan are required' 
    });
  }

  try {
    logInfo('repoops_apply_request', { 
      corr, 
      conn_id, 
      base_branch,
      head_branch,
      changesCount: plan.changes?.length || 0 
    });

    const result = await applyChanges({
      connId: conn_id,
      baseBranch: base_branch,
      headBranch: head_branch,
      plan,
      guardrails: guardrails || {},
      corr
    });

    const response = {
      ok: true,
      correlation_id: corr,
      commit_sha: result.commit_sha,
      compare: result.compare,
      applied: result.applied,
      skipped: result.skipped,
      artifacts: [
        {
          type: 'diff.summary',
          content: JSON.stringify({
            commit: result.commit_sha,
            files_changed: result.applied.length,
            files_skipped: result.skipped.length,
            applied: result.applied,
            skipped: result.skipped,
            compare_summary: {
              ahead_by: result.compare?.ahead_by,
              behind_by: result.compare?.behind_by,
              total_commits: result.compare?.total_commits
            }
          }, null, 2)
        }
      ]
    };

    logInfo('repoops_apply_success', { 
      corr, 
      commit_sha: result.commit_sha,
      applied: result.applied.length,
      skipped: result.skipped.length 
    });

    res.json(response);
  } catch (e) {
    logError('repoops_apply_failed', { corr, error: e.message, stack: e.stack });
    res.status(500).json({ 
      ok: false, 
      correlation_id: corr,
      error: e.message || 'Apply failed' 
    });
  }
});

/**
 * POST /api/repoops/test
 * Clones head_branch on runner and runs tests
 */
router.post('/test', async (req, res) => {
  const corr = `test_${uuid()}`;
  const {
    conn_id,
    head_branch,
    runner,
    commands = [],
    timeoutMs
  } = req.body || {};

  if (!conn_id || !head_branch || !runner) {
    return res.status(400).json({ 
      ok: false, 
      error: 'conn_id, head_branch, and runner are required' 
    });
  }

  if (!commands.length) {
    return res.status(400).json({ 
      ok: false, 
      error: 'At least one test command is required' 
    });
  }

  try {
    logInfo('repoops_test_request', { 
      corr, 
      conn_id, 
      head_branch,
      runner,
      commandsCount: commands.length 
    });

    const result = await runTests({
      connId: conn_id,
      headBranch: head_branch,
      runner,
      commands,
      timeoutMs,
      corr
    });

    const combinedLog = result.results.map(r => 
      [
        `=== Command: ${r.cmd} ===`,
        `Exit code: ${r.exitCode}`,
        r.stdout ? `STDOUT:\n${r.stdout}` : '',
        r.stderr ? `STDERR:\n${r.stderr}` : '',
        r.error ? `ERROR: ${r.error}` : '',
        r.killed ? 'KILLED: timeout' : '',
        ''
      ].filter(Boolean).join('\n')
    ).join('\n');

    const response = {
      ok: result.ok,
      correlation_id: corr,
      all_passed: result.ok,
      results: result.results,
      artifacts: [
        {
          type: 'test.log',
          content: combinedLog,
          size: Buffer.byteLength(combinedLog, 'utf8')
        }
      ]
    };

    logInfo('repoops_test_success', { 
      corr, 
      all_passed: result.ok,
      resultsCount: result.results.length 
    });

    res.json(response);
  } catch (e) {
    logError('repoops_test_failed', { corr, error: e.message, stack: e.stack });
    res.status(500).json({ 
      ok: false, 
      correlation_id: corr,
      error: e.message || 'Test execution failed' 
    });
  }
});

/**
 * POST /api/repoops/pr
 * Creates a pull request
 */
router.post('/pr', async (req, res) => {
  const corr = `pr_${uuid()}`;
  const {
    conn_id,
    base_branch = 'main',
    head_branch,
    title,
    body = '',
    draft = false
  } = req.body || {};

  if (!conn_id || !head_branch || !title) {
    return res.status(400).json({ 
      ok: false, 
      error: 'conn_id, head_branch, and title are required' 
    });
  }

  try {
    logInfo('repoops_pr_request', { 
      corr, 
      conn_id, 
      base_branch,
      head_branch,
      title 
    });

    const result = await createPR({
      connId: conn_id,
      baseBranch: base_branch,
      headBranch: head_branch,
      title,
      body,
      draft,
      corr
    });

    const response = {
      ok: true,
      correlation_id: corr,
      pr: result.pr,
      artifacts: [
        {
          type: 'pr.link',
          content: result.pr.url,
          metadata: {
            number: result.pr.number,
            title: result.pr.title
          }
        }
      ]
    };

    logInfo('repoops_pr_success', { 
      corr, 
      pr_number: result.pr.number,
      pr_url: result.pr.url 
    });

    res.json(response);
  } catch (e) {
    logError('repoops_pr_failed', { corr, error: e.message, stack: e.stack });
    res.status(500).json({ 
      ok: false, 
      correlation_id: corr,
      error: e.message || 'PR creation failed' 
    });
  }
});

/**
 * Background workflow execution
 */
async function executeWorkflowAsync(jobId, params) {
  const {
    conn_id,
    base_branch,
    change_request,
    allow_paths,
    deny_paths,
    language_hints,
    llm_model,
    temperature,
    guardrails,
    test,
    open_pr,
    pr_draft,
    require_approval,
    effectiveHeadBranch,
    corr
  } = params;

  try {
    updateJobStatus(jobId, {
      status: 'running',
      phase: 'planning',
      progress: 10
    });

    const artifacts = [];
    const phases = {};

    // Phase 1 & 2: Plan
    logInfo('repoops_async_planning', { corr, jobId });
    
    const planResult = await runDiscovery({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      languageHints: language_hints,
      model: llm_model,
      temperature,
      corr
    });

    updateJobStatus(jobId, { progress: 30, phase: 'proposing' });

    const proposalResult = await runProposal({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      discovery: planResult.discovery,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      model: llm_model,
      temperature,
      corr
    });

    phases.plan = {
      ok: true,
      discovery: planResult.discovery,
      proposed: proposalResult.proposed
    };

    artifacts.push({
      type: 'plan.discovery',
      content: JSON.stringify(planResult.discovery, null, 2)
    });
    artifacts.push({
      type: 'plan.proposal',
      content: JSON.stringify(proposalResult.proposed, null, 2)
    });

    if (require_approval) {
      logInfo('repoops_approval_required', { corr, jobId });
      updateJobStatus(jobId, {
        status: 'pending_approval',
        phase: 'awaiting_approval',
        progress: 50,
        phases,
        artifacts,
        message: 'Review the plan and call /api/repoops/apply to proceed'
      });
      return;
    }

    // Phase 3: Apply
    updateJobStatus(jobId, { progress: 50, phase: 'applying' });
    logInfo('repoops_async_applying', { corr, jobId });

    const applyResult = await applyChanges({
      connId: conn_id,
      baseBranch: base_branch,
      headBranch: effectiveHeadBranch,
      plan: proposalResult.proposed,
      guardrails,
      corr
    });

    phases.apply = {
      ok: applyResult.ok,
      commit_sha: applyResult.commit_sha,
      applied: applyResult.applied.length,
      skipped: applyResult.skipped.length
    };

    artifacts.push({
      type: 'diff.summary',
      content: JSON.stringify({
        commit: applyResult.commit_sha,
        applied: applyResult.applied,
        skipped: applyResult.skipped
      }, null, 2)
    });

    // Phase 4: Test (if enabled)
    if (test.enabled && test.runner && test.commands?.length) {
      updateJobStatus(jobId, { progress: 70, phase: 'testing' });
      logInfo('repoops_async_testing', { corr, jobId });

      const testResult = await runTests({
        connId: conn_id,
        headBranch: effectiveHeadBranch,
        runner: test.runner,
        commands: test.commands,
        timeoutMs: test.timeoutMs,
        corr
      });

      phases.test = {
        ok: testResult.ok,
        results: testResult.results
      };

      const testLog = testResult.results.map(r => 
        [
          `Command: ${r.cmd}`,
          `Exit: ${r.exitCode}`,
          r.stdout ? `OUT: ${r.stdout.slice(0, 1000)}` : '',
          r.stderr ? `ERR: ${r.stderr.slice(0, 1000)}` : ''
        ].filter(Boolean).join('\n')
      ).join('\n\n');

      artifacts.push({
        type: 'test.log',
        content: testLog
      });

      if (!testResult.ok) {
        logWarn('repoops_async_tests_failed', { corr, jobId });
        updateJobStatus(jobId, {
          status: 'failed',
          phase: 'testing',
          progress: 100,
          phases,
          artifacts,
          error: 'Tests failed',
          message: 'Tests failed. Review logs and fix manually or re-run.'
        });
        return;
      }
    }

    // Phase 5: PR (if requested)
    let prResult = null;
    if (open_pr) {
      updateJobStatus(jobId, { progress: 90, phase: 'creating_pr' });
      logInfo('repoops_async_creating_pr', { corr, jobId });

      const prTitle = proposalResult.proposed.commit_message || 'feat: automated changes';
      const prBody = [
        '## Change Request',
        change_request,
        '',
        '## Changes Applied',
        `- Files changed: ${applyResult.applied.length}`,
        `- Commit: ${applyResult.commit_sha}`,
        '',
        phases.test ? `## Tests: ${phases.test.ok ? '✅ Passed' : '❌ Failed'}` : '',
        '',
        '---',
        '*Generated by RepoOps*'
      ].join('\n');

      prResult = await createPR({
        connId: conn_id,
        baseBranch: base_branch,
        headBranch: effectiveHeadBranch,
        title: prTitle,
        body: prBody,
        draft: pr_draft,
        corr
      });

      phases.pr = {
        ok: true,
        number: prResult.pr.number,
        url: prResult.pr.url
      };

      artifacts.push({
        type: 'pr.link',
        content: prResult.pr.url
      });
    }

    // Success!
    updateJobStatus(jobId, {
      status: 'completed',
      phase: 'done',
      progress: 100,
      head_branch: effectiveHeadBranch,
      phases,
      artifacts,
      pr_url: prResult?.pr?.url || null
    });

    logInfo('repoops_async_completed', { 
      corr,
      jobId,
      pr_created: !!prResult
    });

  } catch (e) {
    logError('repoops_async_failed', { 
      corr, 
      jobId,
      error: e.message, 
      stack: e.stack 
    });
    
    updateJobStatus(jobId, {
      status: 'failed',
      progress: 100,
      error: e.message || 'RepoOps run failed',
      error_stack: e.stack
    });
  }
}

/**
 * GET /api/repoops/status/:job_id
 * Get status of async job
 */
router.get('/status/:job_id', async (req, res) => {
  const { job_id } = req.params;
  
  const job = getJobStatus(job_id);
  
  if (!job) {
    return res.status(404).json({ 
      ok: false,
      error: 'Job not found' 
    });
  }
  
  res.json({
    ok: true,
    job_id,
    ...job
  });
});

/**
 * POST /api/repoops/run
 * Full orchestration: plan -> apply -> test -> pr
 * Supports async mode via { async: true }
 */
router.post('/run', async (req, res) => {
  const corr = `run_${uuid()}`;
  const { async = false } = req.body || {};
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
    guardrails = {},
    test = {},
    open_pr = true,
    pr_draft = false,
    require_approval = false
  } = req.body || {};

  if (!conn_id || !change_request) {
    return res.status(400).json({ 
      ok: false, 
      error: 'conn_id and change_request are required' 
    });
  }

  const effectiveHeadBranch = head_branch || `repoops/${Date.now()}`;

  // ASYNC MODE: Return immediately with job ID
  if (async) {
    const jobId = corr;
    
    // Initialize job status
    updateJobStatus(jobId, {
      status: 'queued',
      phase: 'initializing',
      progress: 0,
      conn_id,
      base_branch,
      head_branch: effectiveHeadBranch,
      change_request: change_request.substring(0, 200) + (change_request.length > 200 ? '...' : ''),
      model: llm_model,
      created_at: new Date().toISOString()
    });

    // Execute in background (don't await)
    setImmediate(() => {
      executeWorkflowAsync(jobId, {
        conn_id,
        base_branch,
        change_request,
        allow_paths,
        deny_paths,
        language_hints,
        llm_model,
        temperature,
        guardrails,
        test,
        open_pr,
        pr_draft,
        require_approval,
        effectiveHeadBranch,
        corr
      }).catch(e => {
        logError('repoops_async_background_error', { 
          jobId, 
          error: e.message 
        });
      });
    });

    logInfo('repoops_async_queued', { 
      corr: jobId,
      conn_id,
      model: llm_model
    });

    return res.json({
      ok: true,
      async: true,
      job_id: jobId,
      status_url: `/api/repoops/status/${jobId}`,
      message: 'Workflow queued. Poll status_url for progress.',
      estimated_duration_seconds: 60
    });
  }

  // SYNCHRONOUS MODE: Execute and wait
  try {
    logInfo('repoops_run_request', { 
      corr, 
      conn_id, 
      base_branch,
      head_branch: effectiveHeadBranch,
      model: llm_model,
      require_approval,
      async: false
    });

    const artifacts = [];
    const phases = {};

    // Phase 1 & 2: Plan
    const planResult = await runDiscovery({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      languageHints: language_hints,
      model: llm_model,
      temperature,
      corr
    });

    const proposalResult = await runProposal({
      connId: conn_id,
      baseBranch: base_branch,
      changeRequest: change_request,
      discovery: planResult.discovery,
      allowPaths: allow_paths,
      denyPaths: deny_paths,
      model: llm_model,
      temperature,
      corr
    });

    phases.plan = {
      ok: true,
      discovery: planResult.discovery,
      proposed: proposalResult.proposed
    };

    artifacts.push({
      type: 'plan.discovery',
      content: JSON.stringify(planResult.discovery, null, 2)
    });
    artifacts.push({
      type: 'plan.proposal',
      content: JSON.stringify(proposalResult.proposed, null, 2)
    });

    if (require_approval) {
      logInfo('repoops_approval_required', { corr });
      return res.json({
        ok: true,
        correlation_id: corr,
        status: 'pending_approval',
        phases,
        artifacts,
        message: 'Review the plan and call /api/repoops/apply to proceed'
      });
    }

    // Phase 3: Apply
    const applyResult = await applyChanges({
      connId: conn_id,
      baseBranch: base_branch,
      headBranch: effectiveHeadBranch,
      plan: proposalResult.proposed,
      guardrails,
      corr
    });

    phases.apply = {
      ok: applyResult.ok,
      commit_sha: applyResult.commit_sha,
      applied: applyResult.applied.length,
      skipped: applyResult.skipped.length
    };

    artifacts.push({
      type: 'diff.summary',
      content: JSON.stringify({
        commit: applyResult.commit_sha,
        applied: applyResult.applied,
        skipped: applyResult.skipped
      }, null, 2)
    });

    // Phase 4: Test (if enabled)
    if (test.enabled && test.runner && test.commands?.length) {
      const testResult = await runTests({
        connId: conn_id,
        headBranch: effectiveHeadBranch,
        runner: test.runner,
        commands: test.commands,
        timeoutMs: test.timeoutMs,
        corr
      });

      phases.test = {
        ok: testResult.ok,
        results: testResult.results
      };

      const testLog = testResult.results.map(r => 
        [
          `Command: ${r.cmd}`,
          `Exit: ${r.exitCode}`,
          r.stdout ? `OUT: ${r.stdout.slice(0, 1000)}` : '',
          r.stderr ? `ERR: ${r.stderr.slice(0, 1000)}` : ''
        ].filter(Boolean).join('\n')
      ).join('\n\n');

      artifacts.push({
        type: 'test.log',
        content: testLog
      });

      if (!testResult.ok) {
        logInfo('repoops_tests_failed', { corr });
        return res.json({
          ok: false,
          correlation_id: corr,
          status: 'tests_failed',
          phases,
          artifacts,
          message: 'Tests failed. Review logs and fix manually or re-run.'
        });
      }
    }

    // Phase 5: PR (if requested)
    let prResult = null;
    if (open_pr) {
      const prTitle = proposalResult.proposed.commit_message || 'feat: automated changes';
      const prBody = [
        '## Change Request',
        change_request,
        '',
        '## Changes Applied',
        `- Files changed: ${applyResult.applied.length}`,
        `- Commit: ${applyResult.commit_sha}`,
        '',
        phases.test ? `## Tests: ${phases.test.ok ? '✅ Passed' : '❌ Failed'}` : '',
        '',
        '---',
        '*Generated by RepoOps*'
      ].join('\n');

      prResult = await createPR({
        connId: conn_id,
        baseBranch: base_branch,
        headBranch: effectiveHeadBranch,
        title: prTitle,
        body: prBody,
        draft: pr_draft,
        corr
      });

      phases.pr = {
        ok: true,
        number: prResult.pr.number,
        url: prResult.pr.url
      };

      artifacts.push({
        type: 'pr.link',
        content: prResult.pr.url
      });
    }

    logInfo('repoops_run_success', { 
      corr,
      pr_created: !!prResult
    });

    res.json({
      ok: true,
      correlation_id: corr,
      status: 'completed',
      head_branch: effectiveHeadBranch,
      phases,
      artifacts
    });

  } catch (e) {
    logError('repoops_run_failed', { corr, error: e.message, stack: e.stack });
    res.status(500).json({ 
      ok: false, 
      correlation_id: corr,
      error: e.message || 'RepoOps run failed',
      phases: {}
    });
  }
});

module.exports = router;