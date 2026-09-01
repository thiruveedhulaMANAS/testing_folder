-- ============================================================================
-- Migration: 005_remove_aava_run_data
-- AAVA execution IDs and responses are transient approval data and must not be
-- persisted in marketing_workflow_runs.
-- Safe to run more than once.
-- ============================================================================

ALTER TABLE marketing_workflow_runs
  DROP COLUMN IF EXISTS aava_execution_id,
  DROP COLUMN IF EXISTS aava_response;
