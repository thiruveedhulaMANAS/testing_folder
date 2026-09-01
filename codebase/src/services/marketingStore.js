const { query } = require('../config/db');

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS marketing_workflow_runs (
  run_id UUID PRIMARY KEY,
  script_id VARCHAR(64) NOT NULL,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  campaign_name TEXT NOT NULL DEFAULT '',
  campaign_details TEXT NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL,
  approval_status VARCHAR(32) NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_workflow_runs_updated_at
  ON marketing_workflow_runs (updated_at DESC);
`;

async function ensureMarketingRunsTable() {
  await query(TABLE_SQL);
  // Existing installations may have these legacy columns from migration 004.
  // AAVA execution IDs and responses are intentionally runtime-only now.
  await query(`
    ALTER TABLE marketing_workflow_runs
      DROP COLUMN IF EXISTS aava_execution_id,
      DROP COLUMN IF EXISTS aava_response
  `);
}

async function insertRun(run) {
  await query(
    `INSERT INTO marketing_workflow_runs
      (run_id, script_id, triggered_by, campaign_name, campaign_details, status,
       approval_status, attempt, error, started_at, finished_at, approved_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (run_id) DO NOTHING`,
    [
      run.id, run.scriptId, run.triggeredById || null, run.campaignName,
      run.campaignDetails, run.status, run.approvalStatus, run.attempt,
      run.approvalError, run.startedAt, run.finishedAt, run.approvedAt || null
    ]
  );
}

async function updateRun(run) {
  await query(
    `UPDATE marketing_workflow_runs
        SET status=$2, approval_status=$3, attempt=$4, error=$5,
            finished_at=$6, approved_at=$7, updated_at=NOW()
      WHERE run_id=$1`,
    [
      run.id, run.status, run.approvalStatus, run.attempt, run.approvalError,
      run.finishedAt, run.approvedAt || null
    ]
  );
}

async function getRun(runId) {
  const result = await query(
    `SELECT run_id, script_id, triggered_by, campaign_name, campaign_details,
            status, approval_status, attempt, error, started_at, finished_at,
            approved_at, updated_at
       FROM marketing_workflow_runs
      WHERE run_id=$1`,
    [runId]
  );
  return result.rows[0] || null;
}

async function listRuns(limit = 50) {
  const result = await query(
    `SELECT run_id, script_id, triggered_by, campaign_name, campaign_details,
            status, approval_status, attempt, error, started_at, finished_at,
            approved_at
       FROM marketing_workflow_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = { ensureMarketingRunsTable, insertRun, updateRun, getRun, listRuns };
