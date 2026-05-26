import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

// GET /api/dashboard/summary
router.get('/summary', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('v_dashboard_summary')
    .select('*')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

// GET /api/dashboard/recent-transactions
router.get('/recent-transactions', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data: payments } = await supabase
    .from('loan_payments')
    .select(`payment_code, amount, payment_date, payment_type, payment_method, customers(full_name, customer_code)`)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: savingsTx } = await supabase
    .from('savings_transactions')
    .select(`transaction_code, amount, transaction_date, transaction_type, customers(full_name, customer_code)`)
    .order('created_at', { ascending: false })
    .limit(10);

  // Merge and sort by date
  const loanTxs = (payments || []).map(p => ({
    code: p.payment_code,
    amount: p.amount,
    date: p.payment_date,
    type: p.payment_type,
    category: 'loan_payment',
    method: p.payment_method,
    customer: p.customers
  }));

  const savTxs = (savingsTx || []).map(s => ({
    code: s.transaction_code,
    amount: s.amount,
    date: s.transaction_date,
    type: s.transaction_type,
    category: 'savings',
    customer: s.customers
  }));

  const combined = [...loanTxs, ...savTxs]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 15);

  res.json({ data: combined });
});

// GET /api/dashboard/monthly-chart - last 6 months loan collections
router.get('/monthly-chart', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase.rpc('get_monthly_collections', {});

  // Fallback if RPC not set up
  if (error) {
    const months: { month: string; collections: number; disbursements: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const monthStr = date.toISOString().slice(0, 7); // YYYY-MM
      const { data: col } = await supabase
        .from('loan_payments')
        .select('amount')
        .gte('payment_date', `${monthStr}-01`)
        .lte('payment_date', `${monthStr}-31`);
      const total = (col || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      months.push({ month: monthStr, collections: total, disbursements: 0 });
    }
    res.json({ data: months });
    return;
  }

  res.json({ data });
});

// GET /api/dashboard/loan-status-chart
router.get('/loan-status-chart', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loans')
    .select('status');

  if (error) { res.status(500).json({ error: error.message }); return; }

  const counts: Record<string, number> = { active: 0, closed: 0, overdue: 0, restructured: 0 };
  (data || []).forEach(l => { counts[l.status] = (counts[l.status] || 0) + 1; });

  const chart = Object.entries(counts).map(([status, count]) => ({ status, count }));
  res.json({ data: chart });
});

export default router;
