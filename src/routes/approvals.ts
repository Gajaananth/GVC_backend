import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireOwner, requireAdmin, AuthRequest } from '../middleware/auth';
import { calculateLoanProduct } from '../utils/loanCalculator';
import { format } from 'date-fns';

const router = Router();
router.use(authenticateJWT);

// GET /api/approvals/loans/pending — owner only
router.get('/loans/pending', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loans')
    .select(`
      *,
      customers(id, customer_code, full_name, phone, nic_number, address),
      applied_by_user:applied_by(id, full_name, user_code),
      in_charge_user:in_charge_user_id(id, full_name, user_code),
      created_by_user:created_by(id, full_name)
    `)
    .eq('approval_status', 'pending_approval')
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/approvals/loans/:id/approve — owner only (optional credit_date if disbursed later)
router.post('/loans/:id/approve', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { credit_date: creditDateOverride } = req.body || {};

  const { data: loan, error: fetchErr } = await supabase
    .from('loans')
    .select('*, customers(full_name)')
    .eq('id', req.params.id)
    .single();

  if (fetchErr || !loan) {
    res.status(404).json({ error: 'Loan not found' });
    return;
  }
  if (loan.approval_status !== 'pending_approval') {
    res.status(400).json({ error: 'Loan is not pending approval' });
    return;
  }

  const creditDate = creditDateOverride || loan.credit_date || loan.start_date;
  const gross = Number(loan.gross_loan_amount || loan.principal_amount);
  const termCount = loan.term_count || loan.duration_months;
  const frequency = loan.repayment_frequency || 'monthly';

  const calc = calculateLoanProduct({
    grossLoanAmount: gross,
    insuranceFeePercent: Number(loan.insurance_fee_percent || 0),
    insuranceFeeFixed: Number(loan.insurance_fee_fixed ?? loan.insurance_fee_amount ?? 0),
    documentationFee: Number(loan.documentation_fee || 0),
    interestRatePerPeriod: Number(loan.interest_rate_per_period || loan.interest_rate),
    termCount,
    repaymentFrequency: frequency,
    creditDate
  });

  const { data: updated, error: updateErr } = await supabase
    .from('loans')
    .update({
      approval_status: 'approved',
      status: 'active',
      credit_date: calc.creditDate,
      first_collection_date: calc.firstCollectionDate,
      start_date: calc.creditDate,
      end_date: calc.endDate,
      total_interest: calc.totalInterest,
      total_payable: calc.totalPayable,
      installment_amount: calc.installmentAmount,
      remaining_balance: calc.totalPayable,
      net_disbursement: calc.netDisbursement,
      next_due_date: calc.firstCollectionDate,
      approved_by: req.user!.id,
      approved_at: new Date().toISOString(),
      updated_by: req.user!.id
    })
    .eq('id', loan.id)
    .select()
    .single();

  if (updateErr || !updated) {
    res.status(500).json({ error: updateErr?.message || 'Approval failed' });
    return;
  }

  const scheduleRows = calc.schedule.map(s => ({
    loan_id: loan.id,
    installment_number: s.installmentNumber,
    due_date: s.dueDate,
    principal_amount: s.principalAmount,
    interest_amount: s.interestAmount,
    installment_amount: s.installmentAmount,
    status: 'pending'
  }));

  await supabase.from('loan_schedule').insert(scheduleRows);

  const reminderRows = calc.schedule.slice(0, 5).map(s => ({
    loan_id: loan.id,
    customer_id: loan.customer_id,
    due_date: s.dueDate,
    amount_due: s.installmentAmount,
    reminder_type: 'installment'
  }));
  await supabase.from('due_reminders').insert(reminderRows);

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'APPROVE',
    entity_type: 'loan',
    entity_id: loan.id,
    entity_code: loan.loan_code,
    description: `Owner approved loan ${loan.loan_code}`
  });

  res.json({ data: updated, message: 'Loan approved and activated' });
});

// POST /api/approvals/loans/:id/reject — owner only
router.post('/loans/:id/reject', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { rejection_reason } = req.body;
  if (!rejection_reason || typeof rejection_reason !== 'string') {
    res.status(400).json({ error: 'Rejection reason is required' });
    return;
  }

  const { data, error } = await supabase
    .from('loans')
    .update({
      approval_status: 'rejected',
      status: 'closed',
      rejection_reason,
      approved_by: req.user!.id,
      approved_at: new Date().toISOString(),
      updated_by: req.user!.id
    })
    .eq('id', req.params.id)
    .eq('approval_status', 'pending_approval')
    .select('id, loan_code, approval_status')
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Loan not found or already processed' });
    return;
  }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'REJECT',
    entity_type: 'loan',
    entity_id: data.id,
    entity_code: data.loan_code,
    description: `Owner rejected loan ${data.loan_code}: ${rejection_reason}`
  });

  res.json({ data, message: 'Loan rejected' });
});

// GET /api/approvals/assignments/pending — owner only
router.get('/assignments/pending', requireOwner, async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loan_assignment_changes')
    .select(`
      *,
      loans(id, loan_code, customer_id, customers(full_name, customer_code)),
      previous:previous_in_charge_id(id, full_name),
      proposed:users!proposed_in_charge_id(id, full_name),
      requester:users!requested_by(id, full_name)
    `)
    .eq('status', 'pending_owner')
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

// POST /api/approvals/assignments/:id/approve — owner only
router.post('/assignments/:id/approve', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: change, error: fetchErr } = await supabase
    .from('loan_assignment_changes')
    .select('*')
    .eq('id', req.params.id)
    .eq('status', 'pending_owner')
    .single();

  if (fetchErr || !change) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }

  await supabase
    .from('loans')
    .update({ in_charge_user_id: change.proposed_in_charge_id, updated_by: req.user!.id })
    .eq('id', change.loan_id);

  const { data, error } = await supabase
    .from('loan_assignment_changes')
    .update({
      status: 'approved',
      reviewed_by: req.user!.id,
      reviewed_at: new Date().toISOString(),
      review_notes: req.body.review_notes || null
    })
    .eq('id', change.id)
    .select()
    .single();

  if (error || !data) {
    res.status(500).json({ error: 'Failed to approve assignment change' });
    return;
  }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'APPROVE',
    entity_type: 'loan_assignment',
    entity_id: change.loan_id,
    description: 'Owner approved in-charge staff change'
  });

  res.json({ data, message: 'In-charge staff updated' });
});

// POST /api/approvals/assignments/:id/reject — owner only
router.post('/assignments/:id/reject', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loan_assignment_changes')
    .update({
      status: 'rejected',
      reviewed_by: req.user!.id,
      reviewed_at: new Date().toISOString(),
      review_notes: req.body.review_notes || 'Rejected by owner'
    })
    .eq('id', req.params.id)
    .eq('status', 'pending_owner')
    .select()
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  res.json({ data, message: 'Assignment change rejected' });
});

// POST /api/approvals/loans/:id/request-in-charge-change — admin only
router.post('/loans/:id/request-in-charge-change', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { proposed_in_charge_id, reason } = req.body;
  if (!proposed_in_charge_id) {
    res.status(400).json({ error: 'proposed_in_charge_id is required' });
    return;
  }

  const { data: loan } = await supabase
    .from('loans')
    .select('id, loan_code, in_charge_user_id')
    .eq('id', req.params.id)
    .single();

  if (!loan) {
    res.status(404).json({ error: 'Loan not found' });
    return;
  }

  if (loan.in_charge_user_id === proposed_in_charge_id) {
    res.status(400).json({ error: 'Staff member is already in charge' });
    return;
  }

  const { data: staff } = await supabase
    .from('users')
    .select('id, role, is_active')
    .eq('id', proposed_in_charge_id)
    .single();

  if (!staff || !staff.is_active || !['staff', 'admin'].includes(staff.role)) {
    res.status(400).json({ error: 'Invalid staff member for in-charge role' });
    return;
  }

  const { data, error } = await supabase
    .from('loan_assignment_changes')
    .insert({
      loan_id: loan.id,
      previous_in_charge_id: loan.in_charge_user_id,
      proposed_in_charge_id,
      reason: reason || null,
      requested_by: req.user!.id
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'REQUEST',
    entity_type: 'loan_assignment',
    entity_id: loan.id,
    entity_code: loan.loan_code,
    description: `Requested in-charge change for loan ${loan.loan_code} (pending owner approval)`
  });

  res.status(201).json({ data, message: 'Change submitted for owner approval' });
});

export default router;
