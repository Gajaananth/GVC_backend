import { Router, Response } from 'express';
import { z } from 'zod';
import { format } from 'date-fns';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireWrite, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const recordPaymentSchema = z.object({
  loan_id: z.string().uuid(),
  payment_date: z.string().optional(),
  amount: z.number().positive(),
  payment_type: z.enum(['regular', 'partial', 'full_settlement', 'advance']),
  payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'mobile']).default('cash'),
  reference_number: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

// GET /api/payments - list payments
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { loan_id, customer_id, start_date, end_date, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('loan_payments')
    .select(`*, loans(loan_code), customers(full_name, customer_code)`, { count: 'exact' })
    .order('payment_date', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (loan_id) query = query.eq('loan_id', loan_id);
  if (customer_id) query = query.eq('customer_id', customer_id);
  if (start_date) query = query.gte('payment_date', start_date);
  if (end_date) query = query.lte('payment_date', end_date);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// POST /api/payments - record a payment
router.post('/', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = recordPaymentSchema.parse(req.body);
    const paymentDate = body.payment_date || format(new Date(), 'yyyy-MM-dd');

    // Get loan details
    const { data: loan, error: loanError } = await supabase
      .from('loans')
      .select('*, customers(id, full_name)')
      .eq('id', body.loan_id)
      .single();

    if (loanError || !loan) { res.status(404).json({ error: 'Loan not found' }); return; }
    if (loan.is_fully_paid) { res.status(400).json({ error: 'Loan is already fully paid' }); return; }
    if (body.amount > loan.remaining_balance + 1) {
      res.status(400).json({ error: `Payment amount ₨${body.amount} exceeds remaining balance ₨${loan.remaining_balance}` });
      return;
    }

    // Calculate principal/interest split (flat rate: interest first, then principal)
    const interestPerInstallment = loan.total_interest / loan.duration_months;
    const interestPaid = Math.min(interestPerInstallment, body.amount);
    const principalPaid = Math.max(0, body.amount - interestPaid);

    const newBalance = Math.max(0, loan.remaining_balance - body.amount);
    const newAmountPaid = loan.amount_paid + body.amount;
    const isFullyPaid = newBalance <= 0.01 || body.payment_type === 'full_settlement';

    // Find next overdue or pending installment to mark
    const { data: pendingInstallments } = await supabase
      .from('loan_schedule')
      .select('*')
      .eq('loan_id', body.loan_id)
      .in('status', ['pending', 'partial', 'overdue'])
      .order('installment_number', { ascending: true })
      .limit(1);

    const currentInstallment = pendingInstallments?.[0];

    // Determine next due date
    let nextDueDate: string | null = null;
    if (!isFullyPaid && currentInstallment) {
      const { data: nextInstallment } = await supabase
        .from('loan_schedule')
        .select('due_date')
        .eq('loan_id', body.loan_id)
        .in('status', ['pending', 'partial'])
        .gt('installment_number', currentInstallment.installment_number)
        .order('installment_number', { ascending: true })
        .limit(1)
        .single();
      nextDueDate = nextInstallment?.due_date || null;
    }

    // Insert payment record
    const { data: payment, error: payError } = await supabase
      .from('loan_payments')
      .insert({
        loan_id: body.loan_id,
        customer_id: loan.customer_id,
        payment_date: paymentDate,
        amount: body.amount,
        principal_paid: principalPaid,
        interest_paid: interestPaid,
        payment_type: body.payment_type,
        payment_method: body.payment_method,
        reference_number: body.reference_number,
        notes: body.notes,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (payError || !payment) { res.status(500).json({ error: payError?.message }); return; }

    // Update loan balance and status
    await supabase.from('loans').update({
      amount_paid: newAmountPaid,
      remaining_balance: newBalance,
      last_payment_date: paymentDate,
      next_due_date: nextDueDate,
      is_fully_paid: isFullyPaid,
      status: isFullyPaid ? 'closed' : loan.status === 'overdue' ? 'active' : loan.status,
      updated_by: req.user!.id
    }).eq('id', body.loan_id);

    // Update installment status
    if (currentInstallment) {
      const newPaid = (currentInstallment.paid_amount || 0) + body.amount;
      const installmentStatus = newPaid >= currentInstallment.installment_amount ? 'paid' : 'partial';
      await supabase.from('loan_schedule').update({
        paid_amount: Math.min(newPaid, currentInstallment.installment_amount),
        status: installmentStatus,
        paid_date: paymentDate
      }).eq('id', currentInstallment.id);
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'payment',
      entity_id: payment.id, entity_code: payment.payment_code,
      description: `Recorded payment ${payment.payment_code} of ₨${body.amount.toLocaleString()} for loan ${loan.loan_code}`
    });

    res.status(201).json({
      data: { ...payment, loan_code: loan.loan_code, new_balance: newBalance, is_fully_paid: isFullyPaid },
      message: isFullyPaid ? 'Loan fully settled!' : 'Payment recorded successfully'
    });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// GET /api/payments/:id - single payment (for receipt)
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loan_payments')
    .select(`*, loans(loan_code, principal_amount, interest_rate, duration_months), customers(full_name, customer_code, nic_number, phone, address)`)
    .eq('id', req.params.id)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Payment not found' }); return; }
  res.json({ data });
});

export default router;
