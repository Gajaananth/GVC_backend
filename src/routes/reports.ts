import { Router, Response } from 'express';
import { z } from 'zod';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

// GET /api/reports/:type?start_date=&end_date=&customer_id=
router.get('/:type', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type } = req.params;
  const { start_date, end_date, customer_id } = req.query;

  const today = new Date();
  const sDate = (start_date as string) || format(startOfMonth(today), 'yyyy-MM-dd');
  const eDate = (end_date as string) || format(endOfMonth(today), 'yyyy-MM-dd');

  try {
    if (req.user?.role === 'staff' && !['daily_collection', 'customer_wise'].includes(type)) {
      res.status(403).json({ error: 'Staff are only permitted to view daily collections and customer-wise reports' });
      return;
    }

    let reportData: unknown;

    switch (type) {
      case 'daily_collection': {
        const { data } = await supabase
          .from('loan_payments')
          .select(`payment_code, payment_date, amount, payment_type, payment_method, loans(loan_code), customers(full_name, customer_code, phone)`)
          .gte('payment_date', sDate)
          .lte('payment_date', eDate)
          .order('payment_date', { ascending: false });

        const total = (data || []).reduce((sum, p) => sum + p.amount, 0);
        reportData = { payments: data || [], total_collected: total, period: { start: sDate, end: eDate } };
        break;
      }

      case 'monthly_finance': {
        const { data: payments } = await supabase
          .from('loan_payments')
          .select('amount, payment_date, payment_type')
          .gte('payment_date', sDate)
          .lte('payment_date', eDate);

        const { data: newLoans } = await supabase
          .from('loans')
          .select('principal_amount, start_date')
          .gte('start_date', sDate)
          .lte('start_date', eDate);

        const { data: savings } = await supabase
          .from('savings_transactions')
          .select('amount, transaction_type, transaction_date')
          .gte('transaction_date', sDate)
          .lte('transaction_date', eDate);

        const totalCollections = (payments || []).reduce((s, p) => s + p.amount, 0);
        const totalDisbursed = (newLoans || []).reduce((s, l) => s + l.principal_amount, 0);
        const totalDeposits = (savings || []).filter(s => s.transaction_type === 'deposit').reduce((s, t) => s + t.amount, 0);
        const totalWithdrawals = (savings || []).filter(s => s.transaction_type === 'withdrawal').reduce((s, t) => s + t.amount, 0);

        reportData = {
          period: { start: sDate, end: eDate },
          loan_collections: totalCollections,
          loans_disbursed: totalDisbursed,
          savings_deposits: totalDeposits,
          savings_withdrawals: totalWithdrawals,
          net_income: totalCollections - totalDisbursed
        };
        break;
      }

      case 'loan_summary': {
        const { data } = await supabase
          .from('loans')
          .select(`*, customers(full_name, customer_code, phone)`)
          .order('created_at', { ascending: false });

        const summary = {
          total: (data || []).length,
          active: (data || []).filter(l => l.status === 'active').length,
          closed: (data || []).filter(l => l.status === 'closed').length,
          overdue: (data || []).filter(l => l.status === 'overdue').length,
          total_disbursed: (data || []).reduce((s, l) => s + l.principal_amount, 0),
          total_outstanding: (data || []).filter(l => l.status !== 'closed').reduce((s, l) => s + l.remaining_balance, 0)
        };
        reportData = { loans: data, summary };
        break;
      }

      case 'savings_summary': {
        const { data } = await supabase
          .from('savings_accounts')
          .select(`*, customers(full_name, customer_code, phone)`)
          .order('created_at', { ascending: false });

        const summary = {
          total_accounts: (data || []).length,
          active_accounts: (data || []).filter(a => a.is_active).length,
          total_balance: (data || []).reduce((s, a) => s + a.balance, 0),
          total_deposited: (data || []).reduce((s, a) => s + a.total_deposited, 0),
          total_withdrawn: (data || []).reduce((s, a) => s + a.total_withdrawn, 0),
          total_interest_earned: (data || []).reduce((s, a) => s + a.total_interest_earned, 0)
        };
        reportData = { accounts: data, summary };
        break;
      }

      case 'customer_wise': {
        const query = supabase
          .from('customers')
          .select(`*, loans(id, loan_code, principal_amount, remaining_balance, status), savings_accounts(id, account_code, balance)`);

        if (customer_id) query.eq('id', customer_id);

        const { data } = await query;
        reportData = { customers: data };
        break;
      }

      case 'due_payment': {
        const { data } = await supabase
          .from('v_overdue_loans')
          .select('*')
          .order('days_overdue', { ascending: false });

        const totalDue = (data || []).reduce((s, l) => s + l.remaining_balance, 0);
        reportData = { overdue_loans: data, total_outstanding: totalDue };
        break;
      }

      case 'income': {
        const { data: payments } = await supabase
          .from('loan_payments')
          .select('amount, interest_paid, payment_date, payment_method')
          .gte('payment_date', sDate)
          .lte('payment_date', eDate);

        const totalIncome = (payments || []).reduce((s, p) => s + (p.interest_paid || 0), 0);
        reportData = {
          period: { start: sDate, end: eDate },
          payments: payments || [],
          total_interest_income: totalIncome
        };
        break;
      }

      default:
        res.status(400).json({ error: `Unknown report type: ${type}` });
        return;
    }

    // Save report snapshot
    await supabase.from('reports').insert({
      report_type: type,
      report_name: `${type.replace(/_/g, ' ').toUpperCase()} - ${format(today, 'dd MMM yyyy')}`,
      period_start: sDate,
      period_end: eDate,
      parameters: { customer_id },
      data: reportData as Record<string, unknown>,
      generated_by: req.user!.id
    });

    res.json({ data: reportData, type, generated_at: today.toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;
