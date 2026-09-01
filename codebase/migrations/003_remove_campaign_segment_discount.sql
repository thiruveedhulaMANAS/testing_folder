-- ============================================================================
-- Migration: 003_remove_campaign_segment_discount
-- The Marketing Automation panel now triggers a single fixed pipeline
-- (scripts/marketing/workflow_backend.py) with no per-run "segment" or
-- "discount percent" parameters, so these columns are no longer written.
--
-- Safe to run more than once.
-- ============================================================================

ALTER TABLE campaign_execution_time DROP COLUMN IF EXISTS segment;
ALTER TABLE campaign_execution_time DROP COLUMN IF EXISTS discount_percent;
