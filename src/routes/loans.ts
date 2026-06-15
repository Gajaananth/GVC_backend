import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';
import { calculateLoanProduct } from '../utils/loanCalculator';
import { TERM_CONFIG } from '../utils/loanTermConfig';
import { format } from 'date-fns';
import { generateLoanApplicationPDF, uploadLoanFormPDF } from '../utils/pdfGenerator';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const router = Router();
router.use(authenticateJWT);

const loanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

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
  applied_by: z.string().uuid().optional().nullable(),
  in_charge_user_id: z.string().uuid().optional().nullable(),
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

  // Apply branch isolation for non-owner roles
  if (req.user?.role !== 'owner') {
    query = query.eq('branch_id', req.user?.branch_id);
  }
  // Staff can only view loans they are in charge of
  if (req.user?.role === 'staff') {
    query = query.eq('in_charge_user_id', req.user.id);
  }

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

  // Ensure loan belongs to user's branch (non-owner)
  if (req.user?.role !== 'owner' && loan.branch_id !== req.user?.branch_id) {
    res.status(403).json({ error: 'Access to loan denied for your branch' });
    return;
  }

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
    .select('*, proposed:users!proposed_in_charge_id(full_name), requester:users!requested_by(full_name)')
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
router.post('/', requireAdmin, loanUpload.single('loan_application_pdf'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isOwnerCreator = req.user?.role === 'owner';
    // Check for required PDF — optional for owner (may be adding old records)
    if (!req.file && !isOwnerCreator) {
      res.status(400).json({ error: 'Loan application PDF is required' });
      return;
    }

    // Parse form fields (strings) to the correct types for Zod
    const parsedBody = {
      customer_id: req.body.customer_id,
      gross_loan_amount: Number(req.body.gross_loan_amount),
      insurance_fee_percent: req.body.insurance_fee_percent != null ? Number(req.body.insurance_fee_percent) : 0,
      insurance_fee_amount: req.body.insurance_fee_amount != null ? Number(req.body.insurance_fee_amount) : 0,
      documentation_fee: req.body.documentation_fee != null ? Number(req.body.documentation_fee) : 0,
      interest_rate_per_period: Number(req.body.interest_rate_per_period),
      term_count: Number(req.body.term_count),
      repayment_frequency: req.body.repayment_frequency,
      credit_date: req.body.credit_date,
      applied_by: req.body.applied_by || null,
      in_charge_user_id: req.body.in_charge_user_id || null,
      purpose: req.body.purpose || null,
      guarantor_name: req.body.guarantor_name || null,
      guarantor_phone: req.body.guarantor_phone || null,
      collateral_notes: req.body.collateral_notes || null,
      notes: req.body.notes || null,
    };

    const body = createLoanSchema.parse(parsedBody);

    const { data: customer } = await supabase
      .from('customers')
      .select('id, full_name, is_active, assigned_staff_id, branch_id, customer_code, phone, nic_number, address')
      .eq('id', body.customer_id)
      .single();

    if (!customer || !customer.is_active) {
      res.status(404).json({ error: 'Customer not found or inactive' });
      return;
    }

    if (!customer.branch_id && !isOwnerCreator) {
      res.status(400).json({ error: 'Customer branch is not assigned' });
      return;
    }

    if (req.user?.role !== 'owner' && req.user?.branch_id !== customer.branch_id) {
      res.status(403).json({ error: 'Cannot create loans for customers outside your branch' });
      return;
    }

    const loanBranchId = customer.branch_id || null;
    const creatorRole = req.user?.role;
    const isOwnerCreation = creatorRole === 'owner';
    const approvalStatus = isOwnerCreation ? 'approved' : 'pending_approval';
    const status = isOwnerCreation ? 'active' : 'pending_approval';

    // Only validate staff if provided — owner can skip staff assignment
    const staffIdsToValidate = [body.applied_by, body.in_charge_user_id].filter(Boolean) as string[];
    for (const staffId of staffIdsToValidate) {
      const { data: staff } = await supabase
        .from('users')
        .select('id, role, is_active, branch_id')
        .eq('id', staffId)
        .single();
      if (!staff || !staff.is_active || !['staff', 'admin', 'branch_manager', 'cashier', 'owner'].includes(staff.role)) {
        res.status(400).json({ error: 'Applied-by and in-charge must be active staff, branch manager, cashier, admin, or owner users' });
        return;
      }
      if (staff.role !== 'owner' && customer.branch_id && staff.branch_id !== customer.branch_id) {
        res.status(400).json({ error: 'Assigned user must belong to the same branch as the customer' });
        return;
      }
    }

    // Non-owner users must provide staff
    if (!isOwnerCreation && (!body.applied_by || !body.in_charge_user_id)) {
      res.status(400).json({ error: 'Staff applied-by and in-charge are required' });
      return;
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

    if (!customer.assigned_staff_id && body.in_charge_user_id) {
      await supabase.from('customers').update({ assigned_staff_id: body.in_charge_user_id }).eq('id', customer.id);
    }

    const { data: loan, error: loanError } = await supabase
      .from('loans')
      .insert({
        customer_id: body.customer_id,
        branch_id: loanBranchId,
        principal_amount: calc.grossLoanAmount,
        gross_loan_amount: calc.grossLoanAmount,
        insurance_fee_percent: body.insurance_fee_percent,
        insurance_fee_amount: calc.insuranceFeeAmount,
        insurance_fee_fixed: body.insurance_fee_amount,
        documentation_fee: calc.documentationFee,
        net_disbursement: calc.netDisbursement,
        interest_rate: body.interest_rate_per_period,
        interest_rate_per_period: body.interest_rate_per_period,
        interest_type: 'monthly',
        repayment_frequency: body.repayment_frequency,
        duration_months: Math.max(1, Math.ceil(calc.totalDurationDays / 30)),
        term_count: body.term_count,
        start_date: calc.creditDate,
        credit_date: calc.creditDate,
        first_collection_date: isOwnerCreation ? calc.firstCollectionDate : null,
        end_date: isOwnerCreation ? calc.endDate : null,
        total_interest: calc.totalInterest,
        total_payable: calc.totalPayable,
        installment_amount: calc.installmentAmount,
        remaining_balance: calc.totalPayable,
        next_due_date: isOwnerCreation ? calc.firstCollectionDate : null,
        purpose: body.purpose,
        guarantor_name: body.guarantor_name,
        guarantor_phone: body.guarantor_phone,
        collateral_notes: body.collateral_notes,
        notes: body.notes,
        status,
        approval_status: approvalStatus,
        applied_by: body.applied_by || null,
        in_charge_user_id: body.in_charge_user_id || null,
        approved_by: isOwnerCreation ? req.user!.id : null,
        approved_at: isOwnerCreation ? new Date().toISOString() : null,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (loanError || !loan) {
      res.status(500).json({ error: loanError?.message || 'Failed to create loan' });
      return;
    }

    // Upload user-provided loan application PDF (if provided)
    let loanApplicationUrl: string | null = null;
    if (req.file) {
      try {
        const BUCKET = process.env.STORAGE_BUCKET || 'gvc-finance-files';
        const ext = path.extname(req.file.originalname) || '.pdf';
        const storagePath = `loans/${loan.id}/application/${uuidv4()}${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from(BUCKET)
          .upload(storagePath, req.file.buffer, {
            contentType: 'application/pdf',
            upsert: false
          });
        if (uploadErr) throw uploadErr;
        const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
        loanApplicationUrl = publicData.publicUrl;
        await supabase.from('loans').update({ loan_application_url: loanApplicationUrl }).eq('id', loan.id);
      } catch (pdfUploadErr) {
        console.error('Failed to upload loan application PDF:', pdfUploadErr);
        // Non-blocking — loan is still created
      }
    }

    // Fetch staff names for the auto-generated PDF
    const { data: appliedByUser } = body.applied_by
      ? await supabase.from('users').select('full_name').eq('id', body.applied_by).single()
      : { data: null };
    const { data: inChargeUser } = body.in_charge_user_id
      ? await supabase.from('users').select('full_name').eq('id', body.in_charge_user_id).single()
      : { data: null };

    // Generate Loan Application PDF and upload to Supabase
    let loanFormUrl: string | null = null;
    try {
      const pdfBuffer = await generateLoanApplicationPDF({
        loanCode: loan.loan_code,
        customerName: customer.full_name,
        customerNic: customer.nic_number || '',
        customerPhone: customer.phone || '',
        customerAddress: customer.address || '',
        customerCode: customer.customer_code || '',
        grossLoanAmount: calc.grossLoanAmount,
        netDisbursement: calc.netDisbursement,
        insuranceFeeAmount: calc.insuranceFeeAmount,
        documentationFee: calc.documentationFee,
        totalFees: calc.totalFees,
        interestRateMonthly: body.interest_rate_per_period,
        totalInterest: calc.totalInterest,
        totalPayable: calc.totalPayable,
        installmentAmount: calc.installmentAmount,
        termCount: calc.termCount,
        repaymentFrequency: body.repayment_frequency,
        creditDate: calc.creditDate,
        firstCollectionDate: calc.firstCollectionDate,
        endDate: calc.endDate,
        purpose: body.purpose,
        guarantorName: body.guarantor_name,
        guarantorPhone: body.guarantor_phone,
        collateralNotes: body.collateral_notes,
        appliedByName: appliedByUser?.full_name || 'N/A',
        inChargeName: inChargeUser?.full_name || 'N/A',
        schedule: calc.schedule
      });

      loanFormUrl = await uploadLoanFormPDF(loan.id, loan.loan_code, pdfBuffer);

      // Update the loan record with the PDF URL
      await supabase.from('loans').update({ loan_form_url: loanFormUrl }).eq('id', loan.id);
    } catch (pdfErr) {
      // PDF generation failure should not block loan creation — log and continue
      console.error('Failed to generate/upload loan form PDF:', pdfErr);
    }

    if (isOwnerCreation) {
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
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'loan',
      entity_id: loan.id, entity_code: loan.loan_code,
      branch_id: req.user!.branch_id,
      description: `Submitted ${body.repayment_frequency} loan ${loan.loan_code} — gross ₨${calc.grossLoanAmount.toLocaleString()}, net disbursement ₨${calc.netDisbursement.toLocaleString()}`
    });

    res.status(201).json({
      data: { ...loan, loan_form_url: loanFormUrl, loan_application_url: loanApplicationUrl, preview: calc },
      message: isOwnerCreation 
        ? 'Loan created successfully and schedule generated.' 
        : 'Loan submitted for owner approval. Schedule is created when owner approves on credit date.'
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
    // Ensure both old and new loans belong to user's branch (owner bypass)
    if (req.user?.role !== 'owner' && oldLoan.branch_id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Cannot restructure loan from another branch' });
      return;
    }
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
      branch_id: oldLoan.branch_id,
      principal_amount: calc.grossLoanAmount,
      gross_loan_amount: calc.grossLoanAmount,
      insurance_fee_percent: 0,
      insurance_fee_amount: 0,
      insurance_fee_fixed: 0,
      documentation_fee: 0,
      net_disbursement: calc.grossLoanAmount,
      interest_rate: body.new_interest_rate_per_period,
      interest_rate_per_period: body.new_interest_rate_per_period,
      interest_type: 'monthly',
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
      branch_id: req.user!.branch_id,
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

  // Ensure loan belongs to user's branch for status updates
  if (req.user?.role !== 'owner') {
    const { data: loanCheck } = await supabase.from('loans').select('branch_id').eq('id', req.params.id).single();
    if (!loanCheck || loanCheck.branch_id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Cannot modify loan from another branch' });
      return;
    }
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

// POST /api/loans/:id/backdate-payments — Owner only: mark installments as paid with exact dates (for migrating old records)
const backdatePaymentSchema = z.object({
  payments: z.array(z.object({
    installment_number: z.number().int().positive(),
    paid_amount: z.number().positive(),
    paid_date: z.string(), // YYYY-MM-DD
    notes: z.string().optional().nullable(),
  }))
});

router.post('/:id/backdate-payments', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const loanId = req.params.id;
    const body = backdatePaymentSchema.parse(req.body);

    // Fetch the loan
    const { data: loan, error: loanErr } = await supabase
      .from('loans')
      .select('*')
      .eq('id', loanId)
      .single();

    if (loanErr || !loan) {
      res.status(404).json({ error: 'Loan not found' });
      return;
    }

    if (loan.approval_status !== 'approved') {
      res.status(400).json({ error: 'Can only backdate payments for approved loans' });
      return;
    }

    // Fetch current schedule
    const { data: schedule, error: schedErr } = await supabase
      .from('loan_schedule')
      .select('*')
      .eq('loan_id', loanId)
      .order('installment_number', { ascending: true });

    if (schedErr || !schedule) {
      res.status(500).json({ error: 'Failed to load schedule' });
      return;
    }

    let totalPaid = 0;
    const updatedInstallments: string[] = [];

    for (const pmt of body.payments) {
      const installment = schedule.find(s => s.installment_number === pmt.installment_number);
      if (!installment) {
        res.status(400).json({ error: `Installment #${pmt.installment_number} not found in schedule` });
        return;
      }

      const installmentAmount = Number(installment.installment_amount);
      const paidAmount = pmt.paid_amount;
      const oldPaidAmount = Number(installment.paid_amount || 0);
      const delta = Math.max(0, paidAmount - oldPaidAmount);

      const newStatus = paidAmount >= installmentAmount ? 'paid' : 'partial';

      // Update the schedule row
      await supabase.from('loan_schedule').update({
        paid_amount: paidAmount,
        status: newStatus,
        paid_date: pmt.paid_date,
      }).eq('id', installment.id);

      updatedInstallments.push(installment.id);
      totalPaid += delta;

      // Calculate interest/principal split
      const proportion = installmentAmount > 0 ? Math.min(paidAmount / installmentAmount, 1) : 0;
      const interestShare = Math.round((Number(installment.interest_amount) * proportion) * 100) / 100;
      const principalShare = Math.round((paidAmount - interestShare) * 100) / 100;

      // Create a loan_payments record for history — insert individually so one failure doesn't block all
      const { error: payInsertErr } = await supabase
        .from('loan_payments')
        .insert({
          loan_id: loanId,
          customer_id: loan.customer_id,
          branch_id: loan.branch_id,
          payment_date: pmt.paid_date,
          amount: delta > 0 ? delta : paidAmount,
          cash_amount: delta > 0 ? delta : paidAmount,
          online_amount: 0,
          payment_type: 'regular',
          payment_method: 'cash',
          principal_paid: principalShare,
          interest_paid: interestShare,
          notes: `Backdated payment for installment #${pmt.installment_number}`,
          approval_status: 'approved',
          approved_by: req.user!.id,
          approved_at: new Date().toISOString(),
          created_by: req.user!.id,
        });
      if (payInsertErr) {
        console.error(`Failed to insert backdated payment for installment #${pmt.installment_number}:`, payInsertErr);
      }
    }

    // Update loan balances
    const newAmountPaid = Number(loan.amount_paid || 0) + totalPaid;
    const newBalance = Math.max(0, Number(loan.remaining_balance) - totalPaid);
    const isFullyPaid = newBalance <= 0.01;

    // Find next unpaid installment for next_due_date
    let nextDueDate: string | null = null;
    if (!isFullyPaid) {
      const { data: nextInst } = await supabase
        .from('loan_schedule')
        .select('due_date')
        .eq('loan_id', loanId)
        .in('status', ['pending', 'partial', 'overdue'])
        .order('installment_number', { ascending: true })
        .limit(1)
        .single();
      nextDueDate = nextInst?.due_date || null;
    }

    // Find last paid date
    const lastPaidDate = body.payments.reduce((latest, p) => {
      return p.paid_date > latest ? p.paid_date : latest;
    }, '');

    await supabase.from('loans').update({
      amount_paid: newAmountPaid,
      remaining_balance: newBalance,
      is_fully_paid: isFullyPaid,
      last_payment_date: lastPaidDate || loan.last_payment_date,
      next_due_date: nextDueDate,
      status: isFullyPaid ? 'closed' : loan.status,
      updated_by: req.user!.id,
    }).eq('id', loanId);

    // Activity log
    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'UPDATE',
      entity_type: 'loan',
      entity_id: loanId,
      entity_code: loan.loan_code,
      branch_id: loan.branch_id,
      description: `Backdated ${body.payments.length} payment(s) totalling ₨${totalPaid.toLocaleString()} for loan ${loan.loan_code}`,
    });

    res.json({
      data: {
        updated_installments: updatedInstallments.length,
        total_paid: totalPaid,
        new_balance: newBalance,
        is_fully_paid: isFullyPaid,
      },
      message: `${body.payments.length} payment(s) backdated successfully`,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    console.error('Backdate payments error:', err);
    res.status(500).json({ error: 'Failed to backdate payments' });
  }
});

export default router;
