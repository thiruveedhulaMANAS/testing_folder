const express = require('express');
const { asyncHandler, HttpError } = require('../../middleware/error');
const { writeAudit } = require('../../services/audit');
const { query } = require('../../config/db');
const runner = require('../../services/marketingRunner');

const router = express.Router();

router.get(
  '/pipeline',
  asyncHandler(async (_req, res) => {
    res.json(runner.getPipelineInfo());
  })
);

router.get(
  '/runs',
  asyncHandler(async (_req, res) => {
    res.json({ runs: await runner.listRuns() });
  })
);

router.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    let run;
    try {
      const campaignName = typeof req.body?.campaignName === 'string' ? req.body.campaignName.trim() : '';
      const campaignDetails = typeof req.body?.campaignDetails === 'string' ? req.body.campaignDetails.trim() : '';
      run = await runner.triggerScript({ triggeredBy: req.user.email, triggeredById: req.user.id, campaignName, campaignDetails });
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }

    // Records the moment the "Trigger" button was clicked, independent of
    // how the script itself turns out. Failures here are logged and
    // swallowed rather than surfaced to the caller -- a hiccup in this
    // bookkeeping insert shouldn't stop the marketing script from running
    // or turn into a false-negative error in the admin UI.
    const executionLogPromise = query(
      `INSERT INTO campaign_execution_time (run_id, script_id, triggered_by)
       VALUES ($1, $2, $3)`,
      [run.id, run.scriptId, req.user.id]
    ).catch((err) => {
      console.error('[marketing] failed to record campaign_execution_time:', err.message);
    });

    await writeAudit(null, {
      userId: req.user.id,
      eventName: 'ADMIN_MARKETING_TRIGGER',
      payload: { runId: run.id, scriptId: run.scriptId, campaignName: run.campaignName }
    });
    await executionLogPromise;

    res.status(202).json({
      runId: run.id,
      status: run.status,
      streamUrl: `/api/admin/marketing/stream/${run.id}`
    });
  })
);

/**
 * Authenticated Server-Sent Events log stream for a single run. The admin UI
 * consumes this stream with fetch() so it can send its bearer token.
 */

router.get(
  '/runs/:runId/approval',
  asyncHandler(async (req, res) => {
    const state = await runner.getApprovalState(req.params.runId);
    if (!state) throw new HttpError(404, 'Run not found');
    res.json(state);
  })
);

router.post(
  '/runs/:runId/approve',
  asyncHandler(async (req, res) => {
    try {
      const run = await runner.approveRun(req.params.runId);
      await writeAudit(null, {
        userId: req.user.id,
        eventName: 'ADMIN_MARKETING_APPROVE',
        payload: { runId: run.id, scriptId: run.scriptId }
      });
      res.json({ runId: run.id, status: run.status, approvalStatus: run.approvalStatus });
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
  })
);

router.post(
  '/runs/:runId/reject',
  asyncHandler(async (req, res) => {
    try {
      const run = await runner.rejectRun(req.params.runId);
      await writeAudit(null, {
        userId: req.user.id,
        eventName: 'ADMIN_MARKETING_REJECT',
        payload: { runId: run.id, scriptId: run.scriptId }
      });
      res.json({ runId: run.id, status: run.status, approvalStatus: run.approvalStatus });
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
  })
);

router.get('/stream/:runId', asyncHandler(async (req, res) => {
  const run = runner.getRun(req.params.runId);
  if (!run) {
    const state = await runner.getApprovalState(req.params.runId);
    if (!state) return res.status(404).json({ error: 'Run not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: approval\ndata: ${JSON.stringify(state)}\n\n`);
    res.write(`event: exit\ndata: ${JSON.stringify({ code: state.status === 'succeeded' ? 0 : null, status: state.status })}\n\n`);
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay anything that already happened before this client connected
  // (the script may have started -- and even finished -- before the
  // browser's stream connection was established).
  for (const entry of run.logs) send('log', entry);
  if (run.approvalStatus !== 'processing') {
    send('approval', {
      approvalStatus: run.approvalStatus,
      response: run.aavaResponse,
      executionId: run.aavaExecutionId,
      error: run.approvalError
    });
  }
  if (run.status !== 'running') {
    send('exit', { code: run.exitCode, status: run.status });
    res.end();
    return;
  }

  const onLog = (entry) => send('log', entry);
  const onApproval = (payload) => send('approval', payload);
  const onExit = (payload) => {
    send('exit', payload);
    cleanup();
    res.end();
  };
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15000);

  function cleanup() {
    clearInterval(heartbeat);
    run.emitter.off('log', onLog);
    run.emitter.off('approval', onApproval);
    run.emitter.off('exit', onExit);
  }

  run.emitter.on('log', onLog);
  run.emitter.on('approval', onApproval);
  run.emitter.on('exit', onExit);
  req.on('close', cleanup);
}));

module.exports = router;
