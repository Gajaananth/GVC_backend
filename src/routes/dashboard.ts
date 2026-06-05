import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

// GET /api/dashboard/summary
router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('v_dashboard_summary')
    .select('*')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { count: pendingLoans } = await supabase
    .from('loans')
    .select('*', { count: 'exact', head: true })
    .eq('approval_status', 'pending_approval');

  const { count: pendingAssignments } = await supabase
    .from('loan_assignment_changes')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_owner');

  const { count: pendingCollections } = await supabase
    .from('loan_payments')
    .select('*', { count: 'exact', head: true })
    .eq('approval_status', 'pending_admin');

  const { count: pendingSavings } = await supabase
    .from('savings_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('approval_status', 'pending_admin');

  const { count: pendingCorrections } = await supabase
    .from('collection_correction_requests')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_owner');

  const { count: pendingPhysicalForms } = await supabase
    .from('physical_form_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_admin');

  res.json({
    data: {
      ...data,
      pending_loan_approvals: pendingLoans || 0,
      pending_assignment_approvals: pendingAssignments || 0,
      pending_collection_approvals: (pendingCollections || 0) + (pendingSavings || 0),
      pending_correction_requests: pendingCorrections || 0,
      pending_physical_forms: pendingPhysicalForms || 0,
      show_owner_approvals: req.user?.role === 'owner',
      show_admin_collections: req.user?.role === 'admin' || req.user?.role === 'owner'
    }
  });
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

// GET /api/dashboard/advanced-metrics
router.get('/advanced-metrics', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // 1. Portfolio At Risk (PAR)
    // PAR > 30 days is standard. Here we'll just sum remaining_balance of overdue loans vs total active balance.
    const { data: loans } = await supabase.from('loans').select('status, remaining_balance').neq('status', 'closed');
    const totalOutstanding = (loans || []).reduce((sum, l) => sum + Number(l.remaining_balance), 0);
    const overdueOutstanding = (loans || []).filter(l => l.status === 'overdue').reduce((sum, l) => sum + Number(l.remaining_balance), 0);
    const parRatio = totalOutstanding > 0 ? (overdueOutstanding / totalOutstanding) * 100 : 0;

    // 2. Top 5 Overdue Loans
    const { data: topOverdue } = await supabase
      .from('v_overdue_loans')
      .select('*')
      .order('remaining_balance', { ascending: false })
      .limit(5);

    // 3. Staff Performance (Collections this month by staff)
    const startOfMonthStr = `${new Date().toISOString().slice(0, 7)}-01`;
    const { data: staffPayments } = await supabase
      .from('loan_payments')
      .select('amount, submitter:users!created_by(id, full_name)')
      .gte('payment_date', startOfMonthStr)
      .eq('approval_status', 'approved');

    const staffMap: Record<string, { name: string, total: number }> = {};
    (staffPayments || []).forEach(p => {
      const submitter: any = Array.isArray(p.submitter) ? p.submitter[0] : p.submitter;
      const staffId = submitter?.id;
      if (staffId) {
        if (!staffMap[staffId]) staffMap[staffId] = { name: submitter?.full_name || 'Unknown', total: 0 };
        staffMap[staffId].total += Number(p.amount);
      }
    });
    
    const staffPerformance = Object.values(staffMap).sort((a, b) => b.total - a.total).slice(0, 5);

    res.json({
      data: {
        portfolio_at_risk_pct: parRatio,
        total_outstanding: totalOutstanding,
        overdue_outstanding: overdueOutstanding,
        top_overdue: topOverdue || [],
        staff_performance: staffPerformance
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch advanced metrics' });
  }
});

export default router;
