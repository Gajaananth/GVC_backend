-- Add closure and block support fields to fixed_deposits
ALTER TABLE public.fixed_deposits
  ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS block_reason TEXT,
  ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS closure_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
