import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';
import { calculateLoanProduct } from '../utils/loanCalculator';
import { TERM_CONFIG } from '../utils/loanTermConfig';
import { format } from 'date-fns';

const router = Router();
router.use(authenticateJWT);

const loanProductFields = {
  customer_id: z.string().uuid(),
  gross_loan_amount: z.number().positive(),
  insurance_fee_percent: z.number().min(0).default(0),
  insurance_fee_amount: z.number().min(0).default(0),
  documentation_fee: z.number().min(0).default(0),
  interest_rate_per_period: z.number().min(0),
  term_count: z.number().int().positive(),
  repayment_frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  credit_date: z.string(),
  applied_by: z.string().uuid(),
  in_charge_user_id: z.string().uuid(),
  purpose: z.string().optional().nullable(),
  guarantor_name: z.string().optional().nullable(),
  guarantor_phone: z.string().optional().nullable(),
  collateral_notes: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
};

const createLoanSchema = z.object(loanProductFields);
const calculateSchema = z.object({
  gross_loan_amount: z.number().positive(),
  insurance_fee_percent: z.number().min(0).default(0),
  insurance_fee_amount: z.number().min(0).default(0),
  documentation_fee: z.number().min(0).default(0),
  interest_rate_per_period: z.number().min(0),
  term_count: z.number().int().positive(),
  repayment_frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
  credit_date: z.string()
});

const restructureSchema = z.object({
  new_interest_rate_per_period: z.number().min(0),
  new_term_count: z.number().int().positive(),
  repayment_frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly'])
});

// GET /api/loans/term-config — term limits & presets per collection type
router.get('/term-config', authenticateJWT, async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ data: TERM_CONFIG });
});

// POST /api/loans/calculate — preview (admin+)
router.post('/calculate', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = calculateSchema.parse(req.body);
    const result = calculateLoanProduct({
      grossLoanAmount: body.gross_loan_amount,
      insuranceFeePercent: body.insurance_fee_percent,
      insuranceFeeFixed: body.insurance_fee_amount,
      documentationFee: body.documentation_fee,
      interestRatePerPeriod: body.interest_rate_per_period,
      termCount: body.term_count,
      repaymentFrequency: body.repayment_frequency,
      creditDate: body.credit_date
    });
    res.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Calculation failed';
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    res.status(400).json({ error: message });
  }
});

// GET /api/loans
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, status, approval_status, customer_id, staff_id, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('loans')
    .select(`
      *,
      customers(id, customer_code, full_name, phone, nic_number, assigned_staff_id),
      applied_by_user:applied_by(id, full_name),
      in_charge_user:in_charge_user_id(id, full_name)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (staff_id) {
    query = query.eq('in_charge_user_id', staff_id as string);
  }

  if (search) {
    const safeSearch = (search as string).replace(/"/g, '');
    query = query.or(`loan_code.ilike."%${safeSearch}%"`);
  }
  if (status) query = query.eq('status', status);
  if (approval_status) query = query.eq('approval_status', approval_status);
  if (customer_id) query = query.eq('customer_id', customer_id);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// GET /api/loans/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.params.id === 'calculate') { res.status(404).json({ error: 'Not found' }); return; }

  const { data: loan, error } = await supabase
    .from('loans')
    .select(`
      *,
      customers(id, customer_code, full_name, phone, nic_number, address, email, assigned_staff_id),
      applied_by_user:applied_by(id, full_name, user_code),
      in_charge_user:in_charge_user_id(id, full_name, user_code),
      approved_by_user:approved_by(id, full_name)
    `)
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

  const { data: assignmentHistory } = await supabase
    .from('loan_assignment_changes')
    .select('*, proposed:proposed_in_charge_id(full_name), requester:requested_by(full_name)')
    .eq('loan_id', req.params.id)
    .order('created_at', { ascending: false });

  res.json({
    data: {
      ...loan,
      schedule: schedule || [],
      payments: payments || [],
      assignment_history: assignmentHistory || []
    }
  });
});

// POST /api/loans
router.post('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createLoanSchema.parse(req.body);

    const { data: customer } = await supabase
      .from('customers')
      .select('id, full_name, is_active, assigned_staff_id')
      .eq('id', body.customer_id)
      .single();

    if (!customer || !customer.is_active) {
      res.status(404).json({ error: 'Customer not found or inactive' });
      return;
    }

    for (const staffId of [body.applied_by, body.in_charge_user_id]) {
      const { data: staff } = await supabase
        .from('users')
        .select('id, role, is_active')
        .eq('id', staffId)
        .single();
      if (!staff || !staff.is_active || !['staff', 'admin'].includes(staff.role)) {
        res.status(400).json({ error: 'Applied-by and in-charge must be active staff or admin users' });
        return;
      }
    }

    const calc = calculateLoanProduct({
      grossLoanAmount: body.gross_loan_amount,
      insuranceFeePercent: body.insurance_fee_percent,
      insuranceFeeFixed: body.insurance_fee_amount,
      documentationFee: body.documentation_fee,
      interestRatePerPeriod: body.interest_rate_per_period,
      termCount: body.term_count,
      repaymentFrequency: body.repayment_frequency,
      creditDate: body.credit_date
    });

    if (!customer.assigned_staff_id) {
      await supabase.from('customers').update({ assigned_staff_id: body.in_charge_user_id }).eq('id', customer.id);
    }

    const { data: loan, error: loanError } = await supabase
      .from('loans')
      .insert({
        customer_id: body.customer_id,
        principal_amount: calc.grossLoanAmount,
        gross_loan_amount: calc.grossLoanAmount,
        insurance_fee_percent: body.insurance_fee_percent,
        insurance_fee_amount: calc.insuranceFeeAmount,
        insurance_fee_fixed: body.insurance_fee_amount,
        documentation_fee: calc.documentationFee,
        net_disbursement: calc.netDisbursement,
        interest_rate: body.interest_rate_per_period,
        interest_rate_per_period: body.interest_rate_per_period,
        interest_type: body.repayment_frequency === 'daily' ? 'daily' : 'monthly',
        repayment_frequency: body.repayment_frequency,
        duration_months: Math.max(1, Math.ceil(calc.totalDurationDays / 30)),
        term_count: body.term_count,
        start_date: calc.creditDate,
        credit_date: calc.creditDate,
        first_collection_date: calc.firstCollectionDate,
        end_date: calc.endDate,
        total_interest: calc.totalInterest,
        total_payable: calc.totalPayable,
        installment_amount: calc.installmentAmount,
        remaining_balance: calc.totalPayable,
        next_due_date: null,
        purpose: body.purpose,
        guarantor_name: body.guarantor_name,
        guarantor_phone: body.guarantor_phone,
        collateral_notes: body.collateral_notes,
        notes: body.notes,
        status: 'pending_approval',
        approval_status: 'pending_approval',
        applied_by: body.applied_by,
        in_charge_user_id: body.in_charge_user_id,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (loanError || !loan) {
      res.status(500).json({ error: loanError?.message || 'Failed to create loan' });
      return;
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'loan',
      entity_id: loan.id, entity_code: loan.loan_code,
      description: `Submitted ${body.repayment_frequency} loan ${loan.loan_code} — gross ₨${calc.grossLoanAmount.toLocaleString()}, net disbursement ₨${calc.netDisbursement.toLocaleString()}`
    });

    res.status(201).json({
      data: { ...loan, preview: calc },
      message: 'Loan submitted for owner approval. Schedule is created when owner approves on credit date.'
    });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    const message = err instanceof Error ? err.message : 'Failed to create loan';
    res.status(400).json({ error: message });
  }
});

// POST /api/loans/:id/restructure - Owner only
router.post('/:id/restructure', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = restructureSchema.parse(req.body);
    const oldLoanId = req.params.id;

    const { data: oldLoan } = await supabase.from('loans').select('*').eq('id', oldLoanId).single();
    if (!oldLoan) { res.status(404).json({ error: 'Loan not found' }); return; }
    if (oldLoan.status === 'closed' || oldLoan.status === 'restructured') {
      res.status(400).json({ error: 'Cannot restructure a closed or already restructured loan' });
      return;
    }

    const today = format(new Date(), 'yyyy-MM-dd');

    const calc = calculateLoanProduct({
      grossLoanAmount: Number(oldLoan.remaining_balance),
      insuranceFeePercent: 0,
      insuranceFeeFixed: 0,
      documentationFee: 0,
      interestRatePerPeriod: body.new_interest_rate_per_period,
      termCount: body.new_term_count,
      repaymentFrequency: body.repayment_frequency,
      creditDate: today
    });

    // Create new loan
    const { data: newLoan, error: loanErr } = await supabase.from('loans').insert({
      customer_id: oldLoan.customer_id,
      principal_amount: calc.grossLoanAmount,
      gross_loan_amount: calc.grossLoanAmount,
      insurance_fee_percent: 0,
      insurance_fee_amount: 0,
      insurance_fee_fixed: 0,
      documentation_fee: 0,
      net_disbursement: calc.grossLoanAmount,
      interest_rate: body.new_interest_rate_per_period,
      interest_rate_per_period: body.new_interest_rate_per_period,
      interest_type: body.repayment_frequency === 'daily' ? 'daily' : 'monthly',
      repayment_frequency: body.repayment_frequency,
      duration_months: Math.max(1, Math.ceil(calc.totalDurationDays / 30)),
      term_count: body.new_term_count,
      start_date: calc.creditDate,
      credit_date: calc.creditDate,
      first_collection_date: calc.firstCollectionDate,
      end_date: calc.endDate,
      total_interest: calc.totalInterest,
      total_payable: calc.totalPayable,
      installment_amount: calc.installmentAmount,
      remaining_balance: calc.totalPayable,
      next_due_date: calc.firstCollectionDate,
      purpose: `Restructured from ${oldLoan.loan_code}`,
      status: 'active',
      approval_status: 'approved',
      applied_by: req.user!.id,
      in_charge_user_id: oldLoan.in_charge_user_id,
      created_by: req.user!.id,
      approved_by: req.user!.id,
      approved_at: new Date().toISOString()
    }).select().single();

    if (loanErr || !newLoan) { throw loanErr; }

    const scheduleRows = calc.schedule.map(s => ({
      loan_id: newLoan.id,
      installment_number: s.installmentNumber,
      due_date: s.dueDate,
      principal_amount: s.principalAmount,
      interest_amount: s.interestAmount,
      installment_amount: s.installmentAmount,
      status: 'pending'
    }));

    await supabase.from('loan_schedule').insert(scheduleRows);

    // Update old loan
    await supabase.from('loans').update({ status: 'restructured', updated_by: req.user!.id }).eq('id', oldLoan.id);
    await supabase.from('loan_schedule').delete().eq('loan_id', oldLoan.id).in('status', ['pending', 'partial', 'overdue']);

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'UPDATE', entity_type: 'loan',
      entity_id: oldLoan.id, entity_code: oldLoan.loan_code,
      description: `Restructured loan into new loan ${newLoan.loan_code}`
    });

    res.status(201).json({ data: newLoan, message: 'Loan restructured successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to restructure loan' });
  }
});

router.put('/:id/status', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { status, notes } = req.body;
  const validStatuses = ['active', 'closed', 'overdue', 'restructured'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  const { data: existing } = await supabase
    .from('loans')
    .select('approval_status')
    .eq('id', req.params.id)
    .single();

  if (!existing || existing.approval_status !== 'approved') {
    res.status(400).json({ error: 'Only approved loans can have operational status changed' });
    return;
  }

  const { data, error } = await supabase
    .from('loans')
    .update({ status, notes: notes || undefined, updated_by: req.user!.id })
    .eq('id', req.params.id)
    .select('id, loan_code, status')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Loan not found' }); return; }
  res.json({ data, message: 'Loan status updated' });
});

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
