-- Migration 014: Grant service_role access to branch-isolated transactional tables
-- Adds permissions for tables affected by migration 013 (branch_id columns)

BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;

-- Grant permissions for transactional tables with branch_id
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loan_payments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.savings_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_correction_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_daily_reconciliations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_documents TO service_role;

COMMIT;
