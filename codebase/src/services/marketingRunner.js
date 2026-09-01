const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const env = require('../config/env');
const store = require('./marketingStore');

const PIPELINE = {
  id: 'marketing_agent',
  file: 'workflow_backend.py',
  label: 'Marketing Agent Pipeline',
  description: 'Exports store data, syncs it to GitHub, and runs it through the Marketing Agent workflow.'
};

const MAX_CONCURRENT_RUNS = 3;
const MAX_TRACKED_RUNS = 50;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

const scriptsDir = path.resolve(env.marketingScriptsDir);
const pythonBin = env.pythonBin;

if (!pythonBin) throw new Error('[marketing-runner] env.pythonBin is not set.');
if (!fs.existsSync(scriptsDir)) throw new Error(`[marketing-runner] marketingScriptsDir does not exist: ${scriptsDir}`);
const pipelineScriptPath = path.join(scriptsDir, PIPELINE.file);
const emailScriptPath = path.join(scriptsDir, 'email_sender.py');
if (!fs.existsSync(pipelineScriptPath)) throw new Error(`[marketing-runner] Pipeline script not found at ${pipelineScriptPath}`);
if (!fs.existsSync(emailScriptPath)) throw new Error(`[marketing-runner] Email sender script not found at ${emailScriptPath}`);

const runs = new Map();

function activeRunCount() {
  let count = 0;
  for (const run of runs.values()) {
    if (!TERMINAL_STATUSES.has(run.status)) count += 1;
  }
  return count;
}

function pruneOldRuns() {
  if (runs.size <= MAX_TRACKED_RUNS) return;
  const finished = [...runs.values()]
    .filter((r) => TERMINAL_STATUSES.has(r.status))
    .sort((a, b) => a.startedAt - b.startedAt);
  while (runs.size > MAX_TRACKED_RUNS && finished.length) runs.delete(finished.shift().id);
}

function snapshot(run) {
  return {
    runId: run.id,
    scriptId: run.scriptId,
    scriptLabel: run.scriptLabel,
    status: run.status,
    approvalStatus: run.approvalStatus,
    attempt: run.attempt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    triggeredBy: run.triggeredBy,
    campaignName: run.campaignName,
    campaignDetails: run.campaignDetails,
    executionId: run.aavaExecutionId,
    response: run.aavaResponse,
    error: run.approvalError
  };
}

async function persist(run) {
  try {
    await store.updateRun(run);
  } catch (err) {
    appendLog(run, 'stderr', `[runner] Failed to persist workflow state: ${err.message}`);
  }
}

function appendLog(run, stream, line) {
  const entry = { stream, line, at: new Date().toISOString() };
  run.logs.push(entry);
  if (run.logs.length > 2000) run.logs.shift();
  run.emitter.emit('log', entry);
}

function buildChildEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PYTHONUNBUFFERED: '1',
    ...(process.env.VIRTUAL_ENV ? { VIRTUAL_ENV: process.env.VIRTUAL_ENV } : {}),
    ...(env.marketingScriptEnv || {})
  };
}

function spawnPython(run, args, label) {
  let child;
  try {
    child = spawn(pythonBin, [pipelineScriptPath, ...args], {
      cwd: scriptsDir,
      shell: false,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    run.status = 'failed';
    run.approvalStatus = 'failed';
    run.approvalError = `[runner] spawn() threw synchronously: ${err.message}`;
    run.finishedAt = new Date();
    appendLog(run, 'stderr', run.approvalError);
    run.emitter.emit('approval', snapshot(run));
    run.emitter.emit('exit', { code: null, status: run.status });
    persist(run);
    return null;
  }

  run.child = child;
  appendLog(run, 'stdout', `[runner] Started ${label}.`);

  const buffers = { stdout: '', stderr: '' };
  const handleLine = (streamName, line) => {
    if (!line) return;
    if (streamName === 'stdout' && line.startsWith('__MARKETING_STATE__')) {
      try {
        const state = JSON.parse(line.slice('__MARKETING_STATE__'.length));
        if (state.status === 'awaiting_approval') {
          run.approvalStatus = 'awaiting_approval';
          run.status = 'awaiting_approval';
          run.aavaResponse = state.response || null;
          run.aavaExecutionId = state.execution_id || null;
          run.approvalError = state.error || null;
          appendLog(run, 'stdout', `[approval] AAVA response is ready for administrator review (attempt ${run.attempt}).`);
          run.emitter.emit('approval', snapshot(run));
          persist(run);
          return;
        }
        if (state.status === 'failed') {
          run.approvalStatus = 'failed';
          run.approvalError = state.error || 'Marketing workflow failed.';
          run.status = 'failed';
          run.emitter.emit('approval', snapshot(run));
          persist(run);
          return;
        }
      } catch (err) {
        appendLog(run, 'stderr', `[runner] Invalid marketing state message: ${err.message}`);
      }
    }
    appendLog(run, streamName, line);
  };
  const onData = (streamName) => (chunk) => {
    buffers[streamName] += chunk.toString('utf8');
    const parts = buffers[streamName].split(/\r?\n/);
    buffers[streamName] = parts.pop() || '';
    parts.forEach((line) => handleLine(streamName, line));
  };
  child.stdout.on('data', onData('stdout'));
  child.stderr.on('data', onData('stderr'));

  child.on('error', (err) => {
    run.child = null;
    run.approvalStatus = 'failed';
    run.approvalError = `[runner] Failed to start script: ${err.message}`;
    run.status = 'failed';
    run.finishedAt = new Date();
    appendLog(run, 'stderr', run.approvalError);
    run.emitter.emit('approval', snapshot(run));
    run.emitter.emit('exit', { code: null, status: run.status });
    persist(run);
  });

  child.on('close', (code) => {
    run.child = null;
    run.exitCode = code;
    if (run.status === 'awaiting_approval') {
      // The Python worker intentionally exits after producing an AAVA result.
      // Node remains the owner of the approval lifecycle.
      appendLog(run, 'stdout', `[runner] ${label} finished; workflow remains awaiting administrator approval.`);
      persist(run);
      return;
    }
    if (run.status === 'failed') {
      run.finishedAt = new Date();
      run.emitter.emit('exit', { code, status: run.status });
      persist(run);
      return;
    }
    if (code === 0) {
      // A successful Python exit without an approval state is invalid for this workflow.
      run.status = 'failed';
      run.approvalStatus = 'failed';
      run.approvalError = 'Marketing worker exited without producing an AAVA approval state.';
    } else {
      run.status = 'failed';
      run.approvalStatus = 'failed';
      run.approvalError = run.approvalError || `Marketing worker exited with code ${code}.`;
    }
    run.finishedAt = new Date();
    appendLog(run, 'stderr', `[runner] ${label} finished unexpectedly: ${run.approvalError}`);
    run.emitter.emit('approval', snapshot(run));
    run.emitter.emit('exit', { code, status: run.status });
    persist(run);
  });

  return child;
}

function spawnEmailSender(run) {
  let child;
  try {
    child = spawn(pythonBin, [emailScriptPath], {
      cwd: scriptsDir,
      shell: false,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    return Promise.reject(new Error(`[email] spawn() threw synchronously: ${err.message}`));
  }

  run.child = child;
  run.status = 'email_sending';
  appendLog(run, 'stdout', '[email] Starting approved marketing email sender.');
  run.emitter.emit('approval', snapshot(run));
  persist(run);

  return new Promise((resolve, reject) => {
    const buffers = { stdout: '', stderr: '' };
    const handleData = (streamName, chunk) => {
      buffers[streamName] += chunk.toString('utf8');
      const parts = buffers[streamName].split(/\r?\n/);
      buffers[streamName] = parts.pop() || '';
      parts.forEach((line) => {
        if (line) appendLog(run, streamName, line);
      });
    };
    child.stdout.on('data', handleData.bind(null, 'stdout'));
    child.stderr.on('data', handleData.bind(null, 'stderr'));
    child.on('error', (err) => {
      run.child = null;
      reject(new Error(`[email] Failed to start email sender: ${err.message}`));
    });
    child.on('close', (code) => {
      run.child = null;
      if (buffers.stdout) appendLog(run, 'stdout', buffers.stdout);
      if (buffers.stderr) appendLog(run, 'stderr', buffers.stderr);
      if (code === 0) resolve();
      else reject(new Error(`[email] Email sender exited with code ${code}.`));
    });
  });
}

async function triggerEmailDelivery(run) {
  try {
    await spawnEmailSender(run);
    run.status = 'succeeded';
    run.approvalStatus = 'approved';
    run.finishedAt = new Date();
    run.approvalError = null;
    appendLog(run, 'stdout', '[email] All approved marketing emails sent successfully.');
  } catch (err) {
    run.status = 'failed';
    run.approvalStatus = 'approved';
    run.finishedAt = new Date();
    run.approvalError = err.message;
    appendLog(run, 'stderr', err.message);
  }
  run.emitter.emit('approval', snapshot(run));
  run.emitter.emit('exit', { code: run.status === 'succeeded' ? 0 : 1, status: run.status });
  await persist(run);
}

async function triggerScript({ triggeredBy, triggeredById, campaignName = '', campaignDetails = '' }) {
  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    const err = new Error('Too many marketing scripts are already running. Try again shortly.');
    err.status = 429;
    throw err;
  }

  const runId = crypto.randomUUID();
  const run = {
    id: runId,
    scriptId: PIPELINE.id,
    scriptLabel: PIPELINE.label,
    status: 'running',
    approvalStatus: 'processing',
    attempt: 1,
    startedAt: new Date(),
    finishedAt: null,
    approvedAt: null,
    exitCode: null,
    triggeredBy,
    triggeredById,
    emitter: new EventEmitter(),
    logs: [],
    campaignName,
    campaignDetails,
    aavaResponse: null,
    aavaExecutionId: null,
    approvalError: null,
    child: null
  };

  runs.set(runId, run);
  pruneOldRuns();
  await store.insertRun(run);
  appendLog(run, 'stdout', `[runner] Marketing run ${runId} created.`);
  spawnPython(run, ['--campaign-name', campaignName, '--campaign-details', campaignDetails], 'full marketing pipeline');
  return run;
}

async function regenerateRun(run) {
  run.attempt += 1;
  run.status = 'regenerating';
  run.approvalStatus = 'processing';
  run.aavaResponse = null;
  run.aavaExecutionId = null;
  run.approvalError = null;
  appendLog(run, 'stdout', `[approval] Rejected. Starting AAVA regeneration attempt ${run.attempt}.`);
  run.emitter.emit('approval', snapshot(run));
  await persist(run);

  const child = spawnPython(run, ['--aava-only'], `AAVA regeneration attempt ${run.attempt}`);
  if (!child) throw new Error('Failed to start AAVA regeneration worker.');
}

function hydrateRun(row) {
  if (!row) return null;
  const run = {
    id: row.run_id,
    scriptId: row.script_id,
    scriptLabel: PIPELINE.label,
    status: row.status,
    approvalStatus: row.approval_status,
    attempt: row.attempt,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    exitCode: row.status === 'succeeded' ? 0 : null,
    triggeredBy: row.triggered_by || null,
    triggeredById: row.triggered_by || null,
    emitter: new EventEmitter(),
    logs: [],
    campaignName: row.campaign_name || '',
    campaignDetails: row.campaign_details || '',
    aavaResponse: null,
    aavaExecutionId: null,
    approvalError: row.error || null,
    child: null
  };
  runs.set(run.id, run);
  return run;
}

async function getOrHydrateRun(runId) {
  const existing = getRun(runId);
  if (existing) return existing;
  return hydrateRun(await store.getRun(runId));
}

async function approveRun(runId) {
  const run = await getOrHydrateRun(runId);
  if (!run) {
    const err = new Error('Run not found');
    err.status = 404;
    throw err;
  }
  if (run.status !== 'awaiting_approval' || run.approvalStatus !== 'awaiting_approval') {
    const err = new Error('The AAVA response is not currently awaiting approval.');
    err.status = 409;
    throw err;
  }
  // Content.txt in GitHub is the authoritative approved payload. Do not copy
  // it into a second local marketing_output.json file; doing so creates a
  // second source of truth and can cause email delivery to use stale data.
  run.approvalStatus = 'approved';
  run.approvedAt = new Date();
  appendLog(run, 'stdout', '[approval] Approved. GitHub Content/Content.txt will be used as the email source.');
  run.emitter.emit('approval', snapshot(run));
  await persist(run);
  await triggerEmailDelivery(run);
  return run;
}

async function rejectRun(runId) {
  const run = await getOrHydrateRun(runId);
  if (!run) {
    const err = new Error('Run not found');
    err.status = 404;
    throw err;
  }
  if (run.status !== 'awaiting_approval' || run.approvalStatus !== 'awaiting_approval') {
    const err = new Error('The AAVA response is not currently awaiting approval.');
    err.status = 409;
    throw err;
  }
  await regenerateRun(run);
  return run;
}

async function getApprovalState(runId) {
  const run = getRun(runId);
  if (run) return snapshot(run);
  const persisted = await store.getRun(runId);
  if (!persisted) return null;
  return {
    runId: persisted.run_id,
    scriptId: persisted.script_id,
    status: persisted.status,
    approvalStatus: persisted.approval_status,
    attempt: persisted.attempt,
    response: null,
    executionId: null,
    error: persisted.error,
    campaignName: persisted.campaign_name,
    campaignDetails: persisted.campaign_details,
    startedAt: persisted.started_at,
    finishedAt: persisted.finished_at,
    approvedAt: persisted.approved_at
  };
}

async function listRuns() {
  const persisted = await store.listRuns(MAX_TRACKED_RUNS);
  const active = new Map([...runs.values()].map((run) => [run.id, snapshot(run)]));
  return persisted.map((row) => active.get(row.run_id) || {
    runId: row.run_id,
    scriptId: row.script_id,
    scriptLabel: PIPELINE.label,
    status: row.status,
    approvalStatus: row.approval_status,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.status === 'succeeded' ? 0 : null,
    triggeredBy: row.triggered_by,
    campaignName: row.campaign_name,
    campaignDetails: row.campaign_details,
    executionId: null,
    response: null,
    error: row.error
  });
}

function getRun(runId) { return runs.get(runId); }
function getPipelineInfo() { return { id: PIPELINE.id, label: PIPELINE.label, description: PIPELINE.description }; }

module.exports = { triggerScript, getRun, listRuns, getPipelineInfo, approveRun, rejectRun, getApprovalState };
