-- Migration 015: Ensure branches endpoint runtime schema exists in Supabase.
-- Run this in Supabase SQL editor if GET /api/branches returns a database 500.

CREATE TABLE IF NOT EXISTS public.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_code TEXT UNIQUE NOT NULL,
  branch_name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

UPDATE public.branches
SET status = 'active'
WHERE status IS NULL;

ALTER TABLE public.branches
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'branches_status_check'
      AND conrelid = 'public.branches'::regclass
  ) THEN
    ALTER TABLE public.branches
      ADD CONSTRAINT branches_status_check CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_branch_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_branch_timestamp ON public.branches;
CREATE TRIGGER trg_update_branch_timestamp
BEFORE UPDATE ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.update_branch_timestamp();

INSERT INTO public.branches (branch_code, branch_name, status)
VALUES ('DEFAULT', 'Default Branch', 'active')
ON CONFLICT (branch_code) DO NOTHING;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO service_role;
