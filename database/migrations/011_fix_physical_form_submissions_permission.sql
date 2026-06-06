-- Migration 011: Grant service_role access to physical form submissions

BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON public.physical_form_submissions TO service_role;

COMMIT;
