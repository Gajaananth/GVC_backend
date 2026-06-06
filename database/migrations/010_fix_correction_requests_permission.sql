-- Migration 010: Grant service_role access to collection correction requests

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_correction_requests TO service_role;

COMMIT;
