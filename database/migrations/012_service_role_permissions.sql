-- Migration 012: Grant service_role access to approval and physical form workflow tables

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.physical_form_submissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loan_assignment_changes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_settings TO service_role;
