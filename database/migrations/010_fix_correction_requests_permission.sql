-- Migration 010: Grant service_role access to collection correction requests

BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_correction_requests TO service_role;

COMMIT;
