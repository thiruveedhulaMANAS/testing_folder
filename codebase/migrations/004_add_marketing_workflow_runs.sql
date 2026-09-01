-- Durable state for the Admin Marketing Automation workflow.
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
