import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireWrite, requireAdmin, AuthRequest } from '../middleware/auth';
import { calculateLoan } from '../utils/calculations';
import { addMonths, format } from 'date-fns';

const router = Router();
router.use(authenticateJWT);

const createLoanSchema = z.object({
  customer_id: z.string().uuid(),
  principal_amount: z.number().positive(),
  interest_rate: z.number().positive(),
  interest_type: z.enum(['daily', 'monthly']),
  duration_months: z.number().int().positive(),
  start_date: z.string(),
  purpose: z.string().optional().nullable(),
  guarantor_name: z.string().optional().nullable(),
  guarantor_phone: z.string().optional().nullable(),
  collateral_notes: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

// GET /api/loans
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, status, customer_id, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('loans')
    .select(`
      *,
      customers(id, customer_code, full_name, phone, nic_number)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (search) {
    query = query.or(`loan_code.ilike.%${search}%`);
  }
  if (status) query = query.eq('status', status);
  if (customer_id) query = query.eq('customer_id', customer_id);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// GET /api/loans/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: loan, error } = await supabase
    .from('loans')
    .select(`*, customers(id, customer_code, full_name, phone, nic_number, address, email)`)
    .eq('id', req.params.id)
    .single();

  if (error || !loan) { res.status(404).json({ error: 'Loan not found' }); return; }

  const { data: schedule } = await supabase
    .from('loan_schedule')
    .select('*')
    .eq('loan_id', req.params.id)
    .order('installment_number', { ascending: true });

  const { data: payments } = await supabase
    .from('loan_payments')
    .select('*')
    .eq('loan_id', req.params.id)
    .order('payment_date', { ascending: false });

  res.json({ data: { ...loan, schedule: schedule || [], payments: payments || [] } });
});

// POST /api/loans (admin+ only — staff cannot issue loans)
router.post('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createLoanSchema.parse(req.body);

    // Verify customer exists and is active
    const { data: customer } = await supabase
      .from('customers')
      .select('id, full_name, is_active')
      .eq('id', body.customer_id)
      .single();

    if (!customer || !customer.is_active) {
      res.status(404).json({ error: 'Customer not found or inactive' });
      return;
    }

    const startDate = new Date(body.start_date);
    const endDate = addMonths(startDate, body.duration_months);

    const calc = calculateLoan({
      principal: body.principal_amount,
      interestRate: body.interest_rate,
      interestType: body.interest_type,
      durationMonths: body.duration_months,
      startDate
    });

    // Determine next due date (first installment)
    const nextDueDate = calc.schedule[0]?.dueDate ?? addMonths(startDate, 1);

    const { data: loan, error: loanError } = await supabase
      .from('loans')
      .insert({
        customer_id: body.customer_id,
        principal_amount: body.principal_amount,
        interest_rate: body.interest_rate,
        interest_type: body.interest_type,
        duration_months: body.duration_months,
        start_date: format(startDate, 'yyyy-MM-dd'),
        end_date: format(endDate, 'yyyy-MM-dd'),
        total_interest: calc.totalInterest,
        total_payable: calc.totalPayable,
        installment_amount: calc.installmentAmount,
        remaining_balance: calc.totalPayable,
        next_due_date: format(nextDueDate, 'yyyy-MM-dd'),
        purpose: body.purpose,
        guarantor_name: body.guarantor_name,
        guarantor_phone: body.guarantor_phone,
        collateral_notes: body.collateral_notes,
        notes: body.notes,
        status: 'active',
        created_by: req.user!.id
      })
      .select()
      .single();

    if (loanError || !loan) {
      res.status(500).json({ error: loanError?.message || 'Failed to create loan' });
      return;
    }

    // Insert installment schedule
    const scheduleRows = calc.schedule.map(s => ({
      loan_id: loan.id,
      installment_number: s.installmentNumber,
      due_date: format(s.dueDate, 'yyyy-MM-dd'),
      principal_amount: s.principalAmount,
      interest_amount: s.interestAmount,
      installment_amount: s.installmentAmount,
      status: 'pending'
    }));

    await supabase.from('loan_schedule').insert(scheduleRows);

    // Create due reminders for upcoming installments
    const reminderRows = calc.schedule.slice(0, 3).map(s => ({
      loan_id: loan.id,
      customer_id: body.customer_id,
      due_date: format(s.dueDate, 'yyyy-MM-dd'),
      amount_due: s.installmentAmount,
      reminder_type: 'installment'
    }));
    await supabase.from('due_reminders').insert(reminderRows);

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'loan',
      entity_id: loan.id, entity_code: loan.loan_code,
      description: `Created loan ${loan.loan_code} of ₨${body.principal_amount.toLocaleString()} for ${customer.full_name}`
    });

    res.status(201).json({ data: { ...loan, schedule: scheduleRows }, message: 'Loan created successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to create loan' });
  }
});

// PUT /api/loans/:id/status - update loan status (admin+ only)
router.put('/:id/status', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { status, notes } = req.body;
  const validStatuses = ['active', 'closed', 'overdue', 'restructured'];

  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  const { data, error } = await supabase
    .from('loans')
    .update({ status, notes: notes || undefined, updated_by: req.user!.id })
    .eq('id', req.params.id)
    .select('id, loan_code, status')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Loan not found' }); return; }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
    action: 'UPDATE', entity_type: 'loan',
    entity_id: data.id, entity_code: data.loan_code,
    description: `Updated loan ${data.loan_code} status to ${status}`
  });

  res.json({ data, message: 'Loan status updated' });
});

// GET /api/loans/:id/schedule
router.get('/:id/schedule', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loan_schedule')
    .select('*')
    .eq('loan_id', req.params.id)
    .order('installment_number', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

export default router;
