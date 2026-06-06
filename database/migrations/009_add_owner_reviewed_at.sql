-- Migration 009: Ensure owner_reviewed_at exists on collection_correction_requests
-- Safe, idempotent migration suitable for Supabase CI

BEGIN;

-- Add the column if it doesn't already exist
ALTER TABLE collection_correction_requests
  ADD COLUMN IF NOT EXISTS owner_reviewed_at TIMESTAMPTZ;

-- Add an index to speed ordering by this column
CREATE INDEX IF NOT EXISTS idx_correction_owner_reviewed_at
  ON collection_correction_requests(owner_reviewed_at);

COMMIT;

-- Verification queries (optional when running interactively)
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'collection_correction_requests' AND column_name = 'owner_reviewed_at';

-- SELECT count(*) FROM collection_correction_requests WHERE status = 'approved';
