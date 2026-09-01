-- ============================================================================
-- Migration: 002_add_campaign_execution_time
-- For databases that already exist and were created before this table.
-- A brand new database created via init.sql already has this shape and
-- does not need this file.
--
-- Safe to run more than once.
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_execution_time (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  script_id         VARCHAR(64) NOT NULL,
  segment           VARCHAR(64) NOT NULL,
  discount_percent  INTEGER NOT NULL,
  triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  executed_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);

CREATE INDEX IF NOT EXISTS idx_campaign_execution_time_run_id ON campaign_execution_time (run_id);
CREATE INDEX IF NOT EXISTS idx_campaign_execution_time_executed_at ON campaign_execution_time (executed_at DESC);
