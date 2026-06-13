-- Fixed Deposits Schema
CREATE TABLE IF NOT EXISTS public.fixed_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fd_code VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES public.branches(id),
    principal_amount NUMERIC(15,2) NOT NULL CHECK (principal_amount > 0),
    interest_rate NUMERIC(5,2) NOT NULL CHECK (interest_rate > 0), -- Annual interest rate
    term_months INTEGER NOT NULL CHECK (term_months > 0),
    maturity_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'matured', 'closed', 'rejected')),
    payout_method VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payout_method IN ('cash', 'bank_transfer', 'cheque')),
    total_maturity_amount NUMERIC(15,2) NOT NULL,
    notes TEXT,
    
    created_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    approved_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.fixed_deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Fixed Deposits View Policy" 
ON public.fixed_deposits FOR SELECT 
USING (
  auth.uid() IN (SELECT id FROM public.users WHERE role = 'owner') OR
  branch_id IN (SELECT branch_id FROM public.users WHERE id = auth.uid())
);

CREATE POLICY "Fixed Deposits Insert Policy" 
ON public.fixed_deposits FOR INSERT 
WITH CHECK (
  auth.uid() IN (SELECT id FROM public.users WHERE role IN ('owner', 'admin', 'branch_manager', 'staff'))
);

CREATE POLICY "Fixed Deposits Update Policy" 
ON public.fixed_deposits FOR UPDATE 
USING (
  auth.uid() IN (SELECT id FROM public.users WHERE role IN ('owner', 'admin', 'branch_manager'))
);

-- Triggers for updated_at
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.fixed_deposits 
  FOR EACH ROW EXECUTE PROCEDURE moddatetime (updated_at);
