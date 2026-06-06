import { Router, Response } from 'express';
import { z } from 'zod';
import { format } from 'date-fns';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, AuthRequest } from '../middleware/auth';
import { applyLoanPayment } from '../utils/applyPayment';
import { sendSMS } from '../utils/sms';

const router = Router();
router.use(authenticateJWT);

const recordPaymentSchema = z.object({
  loan_id: z.string().uuid(),
  payment_date: z.string().optional(),
  amount: z.number().positive(),
  cash_amount: z.number().min(0).optional(),
  online_amount: z.number().min(0).optional(),
  payment_type: z.enum(['regular', 'partial', 'full_settlement', 'advance']),
  payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'mobile']).default('cash'),
  reference_number: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

// GET /api/payments
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { loan_id, customer_id, start_date, end_date, approval_status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  const user = req.user;
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

  let query = supabase
    .from('loan_payments')
    .select(`*, loans(loan_code), customers(full_name, customer_code)`, { count: 'exact' })
    .order('payment_date', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (loan_id) query = query.eq('loan_id', loan_id);
  if (customer_id) query = query.eq('customer_id', customer_id);
  if (start_date) query = query.gte('payment_date', start_date);
  if (end_date) query = query.lte('payment_date', end_date);
  if (approval_status) query = query.eq('approval_status', approval_status);

  // Scope results by branch/staff
  if (user.role === 'staff') {
    query = query.eq('created_by', user.id);
  } else if (user.role !== 'owner') {
    query = query.eq('branch_id', user.branch_id);
  }

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// POST /api/payments — admin/owner only, immediate approval (staff use /api/collections/submit/payment)
router.post('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const body = recordPaymentSchema.parse(req.body);
    const paymentDate = body.payment_date || format(new Date(), 'yyyy-MM-dd');
    const cashAmount = body.cash_amount ?? (body.payment_method === 'cash' ? body.amount : 0);
    const onlineAmount = body.online_amount ?? (body.payment_method !== 'cash' ? body.amount : 0);

    const { data: loan } = await supabase
      .from('loans')
      .select('*, customers(id, full_name, phone)')
      .eq('id', body.loan_id)
      .single();

    if (!loan) { res.status(404).json({ error: 'Loan not found' }); return; }
    if (loan.approval_status !== 'approved' || loan.status === 'pending_approval') {
      res.status(400).json({ error: 'Payments only on owner-approved loans' });
      return;
    }
    if (loan.is_fully_paid) { res.status(400).json({ error: 'Loan is already fully paid' }); return; }
    if (body.amount > loan.remaining_balance + 1) {
      res.status(400).json({ error: `Amount exceeds remaining balance` });
      return;
    }

    const { data: payment, error: payError } = await supabase
      .from('loan_payments')
      .insert({
        loan_id: body.loan_id,
        customer_id: loan.customer_id,
        payment_date: paymentDate,
        amount: body.amount,
        cash_amount: cashAmount,
        online_amount: onlineAmount,
        payment_type: body.payment_type,
        payment_method: body.payment_method,
        reference_number: body.reference_number,
        notes: body.notes,
        approval_status: 'approved',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        created_by: user.id
      })
      .select()
      .single();

    if (payError || !payment) { res.status(500).json({ error: payError?.message }); return; }

    const result = await applyLoanPayment(payment.id, user.id);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    const { data: updatedLoan } = await supabase.from('loans').select('remaining_balance, is_fully_paid').eq('id', body.loan_id).single();

    await supabase.from('activity_logs').insert({
      user_id: user.id, user_name: user.full_name, user_role: user.role,
      action: 'CREATE', entity_type: 'payment',
      entity_id: payment.id, entity_code: payment.payment_code,
      description: `Admin recorded payment ${payment.payment_code}`
    });

    // Send SMS Receipt
    if (loan.customers && loan.customers.phone) {
      const message = `Dear ${loan.customers.full_name}, your payment of LKR ${body.amount} for loan ${loan.loan_code} has been received. Thank you. GVC Agro Finance.`;
      await sendSMS(loan.customers.phone, message);
    }

    res.status(201).json({
      data: { ...payment, loan_code: loan.loan_code, new_balance: updatedLoan?.remaining_balance, is_fully_paid: updatedLoan?.is_fully_paid },
      message: updatedLoan?.is_fully_paid ? 'Loan fully settled!' : 'Payment recorded'
    });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loan_payments')
    .select(`*, loans(loan_code, principal_amount, interest_rate, duration_months), customers(full_name, customer_code, nic_number, phone, address)`)
    .eq('id', req.params.id)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Payment not found' }); return; }
  const user = req.user;
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  // Branch isolation
  if (user.role !== 'owner' && data.branch_id !== user.branch_id) {
    res.status(403).json({ error: 'Access to payment denied for your branch' });
    return;
  }
  // Staff can only access payments they created
  if (user.role === 'staff' && data.created_by !== user.id) {
    res.status(403).json({ error: 'Access to payment denied' });
    return;
  }
  res.json({ data });
});

export default router;
