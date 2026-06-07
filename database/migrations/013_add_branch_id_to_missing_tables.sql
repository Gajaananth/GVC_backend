-- Migration 013: Add branch_id to all missing tables
-- This migration ensures multi-branch data isolation across the GVC Finance system
-- Safe, idempotent migration with proper foreign key constraints and indexes

BEGIN;

-- ============================================================
-- 1. LOAN_PAYMENTS - Add branch_id with loan relationship
-- ============================================================
-- Purpose: Track which branch processed each loan payment for branch-specific reporting
-- and ensures data isolation at the payment level

ALTER TABLE loan_payments
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from the related loan's branch_id
UPDATE loan_payments lp
  SET branch_id = l.branch_id
  FROM loans l
  WHERE lp.loan_id = l.id AND lp.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE loan_payments
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
ALTER TABLE loan_payments
  ADD CONSTRAINT IF NOT EXISTS fk_loan_payments_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_loan_payments_branch_id
  ON loan_payments(branch_id);

-- ============================================================
-- 2. SAVINGS_TRANSACTIONS - Add branch_id with customer relationship
-- ============================================================
-- Purpose: Track which branch processed each savings transaction
-- enables branch-specific savings analytics and reconciliation

ALTER TABLE savings_transactions
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from the customer's branch_id via savings_accounts
UPDATE savings_transactions st
  SET branch_id = c.branch_id
  FROM savings_accounts sa
  JOIN customers c ON sa.customer_id = c.id
  WHERE st.account_id = sa.id AND st.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE savings_transactions
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
ALTER TABLE savings_transactions
  ADD CONSTRAINT IF NOT EXISTS fk_savings_transactions_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_savings_transactions_branch_id
  ON savings_transactions(branch_id);

-- ============================================================
-- 3. COLLECTION_CORRECTION_REQUESTS - Add branch_id with entity relationship
-- ============================================================
-- Purpose: Track which branch initiated each correction request
-- supports branch-level approval workflows and audit trails

ALTER TABLE collection_correction_requests
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from related entity (loan_payment or savings_transaction)
-- For loan_payment corrections, get branch from loan_payments
UPDATE collection_correction_requests ccr
  SET branch_id = lp.branch_id
  FROM loan_payments lp
  WHERE ccr.entity_type = 'loan_payment' AND ccr.entity_id = lp.id AND ccr.branch_id IS NULL;

-- For savings_transaction corrections, get branch from savings_transactions
UPDATE collection_correction_requests ccr
  SET branch_id = st.branch_id
  FROM savings_transactions st
  WHERE ccr.entity_type = 'savings_transaction' AND ccr.entity_id = st.id AND ccr.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE collection_correction_requests
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
ALTER TABLE collection_correction_requests
  ADD CONSTRAINT IF NOT EXISTS fk_collection_correction_requests_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_collection_correction_requests_branch_id
  ON collection_correction_requests(branch_id);

-- ============================================================
-- 4. LOAN_ASSIGNMENT_CHANGES - Add branch_id with loan relationship
-- ============================================================
-- Purpose: Track which branch has pending or completed loan officer reassignments
-- facilitates branch-level approval workflows and staff management

ALTER TABLE loan_assignment_changes
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from the related loan's branch_id
UPDATE loan_assignment_changes lac
  SET branch_id = l.branch_id
  FROM loans l
  WHERE lac.loan_id = l.id AND lac.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE loan_assignment_changes
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
ALTER TABLE loan_assignment_changes
  ADD CONSTRAINT IF NOT EXISTS fk_loan_assignment_changes_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_loan_assignment_changes_branch_id
  ON loan_assignment_changes(branch_id);

-- ============================================================
-- 5. STAFF_DAILY_RECONCILIATIONS - Add branch_id with staff relationship
-- ============================================================
-- Purpose: Track which branch each staff member's daily reconciliation belongs to
-- enables branch-level cash/online verification workflows and audit

ALTER TABLE staff_daily_reconciliations
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from the staff user's branch_id
UPDATE staff_daily_reconciliations sdr
  SET branch_id = u.branch_id
  FROM users u
  WHERE sdr.staff_user_id = u.id AND sdr.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE staff_daily_reconciliations
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
-- Use RESTRICT to prevent accidental deletion of branches with pending reconciliations
ALTER TABLE staff_daily_reconciliations
  ADD CONSTRAINT IF NOT EXISTS fk_staff_daily_reconciliations_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_staff_daily_reconciliations_branch_id
  ON staff_daily_reconciliations(branch_id);

-- ============================================================
-- 6. CUSTOMER_DOCUMENTS - Add branch_id with customer relationship
-- ============================================================
-- Purpose: Track which branch processed each customer document
-- ensures documents are visible/auditable within their branch context

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Populate branch_id from the customer's branch_id
UPDATE customer_documents cd
  SET branch_id = c.branch_id
  FROM customers c
  WHERE cd.customer_id = c.id AND cd.branch_id IS NULL;

-- Make branch_id NOT NULL after population
ALTER TABLE customer_documents
  ALTER COLUMN branch_id SET NOT NULL;

-- Add foreign key constraint to branches table
ALTER TABLE customer_documents
  ADD CONSTRAINT IF NOT EXISTS fk_customer_documents_branch
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- Create index for efficient branch-based filtering
CREATE INDEX IF NOT EXISTS idx_customer_documents_branch_id
  ON customer_documents(branch_id);

COMMIT;

-- ============================================================
-- Verification Queries (optional when running interactively)
-- ============================================================
-- Run these to verify the migration completed successfully:

-- SELECT table_name, column_name, is_nullable
-- FROM information_schema.columns
-- WHERE table_name IN (
--   'loan_payments', 'savings_transactions', 'collection_correction_requests',
--   'loan_assignment_changes', 'staff_daily_reconciliations', 'customer_documents'
-- ) AND column_name = 'branch_id'
-- ORDER BY table_name;

-- Check for NULL branch_id values (should be none):
-- SELECT 'loan_payments' as table_name, COUNT(*) as null_count FROM loan_payments WHERE branch_id IS NULL
-- UNION ALL SELECT 'savings_transactions', COUNT(*) FROM savings_transactions WHERE branch_id IS NULL
-- UNION ALL SELECT 'collection_correction_requests', COUNT(*) FROM collection_correction_requests WHERE branch_id IS NULL
-- UNION ALL SELECT 'loan_assignment_changes', COUNT(*) FROM loan_assignment_changes WHERE branch_id IS NULL
-- UNION ALL SELECT 'staff_daily_reconciliations', COUNT(*) FROM staff_daily_reconciliations WHERE branch_id IS NULL
-- UNION ALL SELECT 'customer_documents', COUNT(*) FROM customer_documents WHERE branch_id IS NULL;

-- Check foreign key constraints:
-- SELECT constraint_name, table_name, column_name
-- FROM information_schema.key_column_usage
-- WHERE constraint_name LIKE 'fk_%_branch%'
-- ORDER BY table_name;

-- Check indexes:
-- SELECT tablename, indexname FROM pg_indexes
-- WHERE indexname LIKE 'idx_%_branch_id'
-- ORDER BY tablename;
