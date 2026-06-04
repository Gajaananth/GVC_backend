"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_1 = require("date-fns");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const applyPayment_1 = require("../utils/applyPayment");
const applySavings_1 = require("../utils/applySavings");
const sms_1 = require("../utils/sms");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const requireStaff = (0, auth_1.requireRole)('staff');
const requireAdminOrOwner = (0, auth_1.requireRole)('owner', 'admin');
const today = () => (0, date_fns_1.format)(new Date(), 'yyyy-MM-dd');
const staffPaymentSchema = zod_1.z.object({
    loan_id: zod_1.z.string().uuid(),
    amount: zod_1.z.number().positive(),
    cash_amount: zod_1.z.number().min(0),
    online_amount: zod_1.z.number().min(0),
    payment_type: zod_1.z.enum(['regular', 'partial', 'full_settlement', 'advance']).default('regular'),
    notes: zod_1.z.string().optional().nullable()
}).refine(d => Math.abs(d.cash_amount + d.online_amount - d.amount) < 0.01, {
    message: 'Cash + online must equal total amount'
});
const staffSavingsSchema = zod_1.z.object({
    account_id: zod_1.z.string().uuid(),
    transaction_type: zod_1.z.enum(['deposit', 'withdrawal']),
    amount: zod_1.z.number().positive(),
    cash_amount: zod_1.z.number().min(0),
    online_amount: zod_1.z.number().min(0),
    description: zod_1.z.string().optional().nullable()
}).refine(d => Math.abs(d.cash_amount + d.online_amount - d.amount) < 0.01, {
    message: 'Cash + online must equal total amount'
});
const reconciliationSchema = zod_1.z.object({
    staff_user_id: zod_1.z.string().uuid(),
    reconciliation_date: zod_1.z.string(),
    declared_cash_total: zod_1.z.number().min(0),
    declared_online_total: zod_1.z.number().min(0),
    admin_notes: zod_1.z.string().optional().nullable()
});
const correctionSchema = zod_1.z.object({
    entity_type: zod_1.z.enum(['loan_payment', 'savings_transaction']),
    entity_id: zod_1.z.string().uuid(),
    request_type: zod_1.z.enum(['void', 'amend']),
    letter_description: zod_1.z.string().min(10),
    proposed_amount: zod_1.z.number().positive().optional(),
    proposed_cash_amount: zod_1.z.number().min(0).optional(),
    proposed_online_amount: zod_1.z.number().min(0).optional(),
    proposed_transaction_date: zod_1.z.string().optional()
});
const executeCorrectionSchema = zod_1.z.object({
    amount: zod_1.z.number().positive().optional(),
    cash_amount: zod_1.z.number().min(0).optional(),
    online_amount: zod_1.z.number().min(0).optional(),
    transaction_date: zod_1.z.string().optional(),
    void_only: zod_1.z.boolean().optional()
});
async function getStaffDayTotals(staffId, date) {
    const { data: payments } = await supabase_1.supabase
        .from('loan_payments')
        .select('cash_amount, online_amount, amount, approval_status')
        .eq('created_by', staffId)
        .eq('payment_date', date)
        .in('approval_status', ['pending_admin', 'approved']);
    const { data: savings } = await supabase_1.supabase
        .from('savings_transactions')
        .select('cash_amount, online_amount, amount, approval_status')
        .eq('created_by', staffId)
        .eq('transaction_date', date)
        .in('approval_status', ['pending_admin', 'approved']);
    const all = [...(payments || []), ...(savings || [])];
    return {
        system_cash_total: all.reduce((s, r) => s + Number(r.cash_amount || 0), 0),
        system_online_total: all.reduce((s, r) => s + Number(r.online_amount || 0), 0),
        entry_count: all.length,
        pending_count: all.filter(r => r.approval_status === 'pending_admin').length
    };
}
async function isReconciliationBalanced(staffId, date) {
    const { data } = await supabase_1.supabase
        .from('staff_daily_reconciliations')
        .select('status')
        .eq('staff_user_id', staffId)
        .eq('reconciliation_date', date)
        .eq('status', 'balanced')
        .maybeSingle();
    return !!data;
}
// POST /api/collections/submit/payment — staff only, date locked to today
router.post('/submit/payment', requireStaff, async (req, res) => {
    try {
        const body = staffPaymentSchema.parse(req.body);
        const paymentDate = today();
        const { data: loan } = await supabase_1.supabase
            .from('loans')
            .select('id, loan_code, customer_id, remaining_balance, approval_status, is_fully_paid, status')
            .eq('id', body.loan_id)
            .single();
        if (!loan || loan.approval_status !== 'approved' || loan.is_fully_paid) {
            res.status(400).json({ error: 'Loan not available for collection' });
            return;
        }
        if (body.amount > Number(loan.remaining_balance) + 1) {
            res.status(400).json({ error: 'Amount exceeds remaining balance' });
            return;
        }
        const { data: payment, error } = await supabase_1.supabase
            .from('loan_payments')
            .insert({
            loan_id: body.loan_id,
            customer_id: loan.customer_id,
            payment_date: paymentDate,
            amount: body.amount,
            cash_amount: body.cash_amount,
            online_amount: body.online_amount,
            payment_type: body.payment_type,
            payment_method: body.cash_amount >= body.online_amount ? 'cash' : 'mobile',
            notes: body.notes,
            approval_status: 'pending_admin',
            principal_paid: 0,
            interest_paid: 0,
            created_by: req.user.id
        })
            .select()
            .single();
        if (error || !payment) {
            res.status(500).json({ error: error?.message || 'Failed to submit' });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'SUBMIT',
            entity_type: 'payment',
            entity_id: payment.id,
            entity_code: payment.payment_code,
            description: `Staff submitted collection ${payment.payment_code} (pending admin approval)`
        });
        res.status(201).json({
            data: payment,
            message: 'Collection submitted. Admin will verify cash/online totals before approval.'
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: err.errors[0]?.message || 'Validation error' });
            return;
        }
        res.status(500).json({ error: 'Failed to submit collection' });
    }
});
// POST /api/collections/submit/savings — staff only
router.post('/submit/savings', requireStaff, async (req, res) => {
    try {
        const body = staffSavingsSchema.parse(req.body);
        const txDate = today();
        const { data: account } = await supabase_1.supabase
            .from('savings_accounts')
            .select('id, customer_id, account_code, balance, minimum_balance, is_active')
            .eq('id', body.account_id)
            .single();
        if (!account || !account.is_active) {
            res.status(404).json({ error: 'Savings account not found or inactive' });
            return;
        }
        if (body.transaction_type === 'withdrawal') {
            const available = Number(account.balance) - Number(account.minimum_balance);
            if (body.amount > available) {
                res.status(400).json({ error: `Insufficient balance. Available: ₨${available.toLocaleString()}` });
                return;
            }
        }
        const { data: tx, error } = await supabase_1.supabase
            .from('savings_transactions')
            .insert({
            account_id: body.account_id,
            customer_id: account.customer_id,
            transaction_type: body.transaction_type,
            amount: body.amount,
            cash_amount: body.cash_amount,
            online_amount: body.online_amount,
            balance_after: Number(account.balance),
            transaction_date: txDate,
            payment_method: body.cash_amount >= body.online_amount ? 'cash' : 'mobile',
            description: body.description,
            approval_status: 'pending_admin',
            created_by: req.user.id
        })
            .select()
            .single();
        if (error || !tx) {
            res.status(500).json({ error: error?.message || 'Failed to submit' });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'SUBMIT',
            entity_type: 'savings_transaction',
            entity_id: tx.id,
            entity_code: tx.transaction_code,
            description: `Staff submitted savings ${body.transaction_type} (pending admin)`
        });
        res.status(201).json({ data: tx, message: 'Savings entry submitted for admin approval.' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: err.errors[0]?.message || 'Validation error' });
            return;
        }
        res.status(500).json({ error: 'Failed to submit savings entry' });
    }
});
// GET /api/collections/pending — admin/owner
router.get('/pending', auth_1.requireAdmin, async (req, res) => {
    const { staff_id, date } = req.query;
    const filterDate = date || today();
    let payQuery = supabase_1.supabase
        .from('loan_payments')
        .select(`*, loans(loan_code), customers(full_name, customer_code), submitter:created_by(id, full_name)`)
        .eq('approval_status', 'pending_admin')
        .eq('payment_date', filterDate)
        .order('created_at', { ascending: false });
    let savQuery = supabase_1.supabase
        .from('savings_transactions')
        .select(`*, savings_accounts(account_code), customers(full_name), submitter:created_by(id, full_name)`)
        .eq('approval_status', 'pending_admin')
        .eq('transaction_date', filterDate)
        .order('created_at', { ascending: false });
    if (staff_id) {
        payQuery = payQuery.eq('created_by', staff_id);
        savQuery = savQuery.eq('created_by', staff_id);
    }
    const [{ data: payments }, { data: savings }] = await Promise.all([payQuery, savQuery]);
    res.json({
        data: {
            date: filterDate,
            payments: payments || [],
            savings: savings || []
        }
    });
});
// GET /api/collections/reconciliation/:staffId/:date
router.get('/reconciliation/:staffId/:date', auth_1.requireAdmin, async (req, res) => {
    const { staffId, date } = req.params;
    const totals = await getStaffDayTotals(staffId, date);
    const { data: existing } = await supabase_1.supabase
        .from('staff_daily_reconciliations')
        .select('*')
        .eq('staff_user_id', staffId)
        .eq('reconciliation_date', date)
        .maybeSingle();
    const { data: staff } = await supabase_1.supabase.from('users').select('id, full_name').eq('id', staffId).single();
    res.json({
        data: {
            staff,
            date,
            ...totals,
            reconciliation: existing || null
        }
    });
});
// POST /api/collections/reconciliation — admin verifies cash + online match
router.post('/reconciliation', auth_1.requireAdmin, async (req, res) => {
    try {
        const body = reconciliationSchema.parse(req.body);
        const totals = await getStaffDayTotals(body.staff_user_id, body.reconciliation_date);
        const cashMatch = Math.abs(totals.system_cash_total - body.declared_cash_total) < 0.01;
        const onlineMatch = Math.abs(totals.system_online_total - body.declared_online_total) < 0.01;
        const status = cashMatch && onlineMatch ? 'balanced' : 'discrepancy';
        const { data, error } = await supabase_1.supabase
            .from('staff_daily_reconciliations')
            .upsert({
            staff_user_id: body.staff_user_id,
            reconciliation_date: body.reconciliation_date,
            declared_cash_total: body.declared_cash_total,
            declared_online_total: body.declared_online_total,
            system_cash_total: totals.system_cash_total,
            system_online_total: totals.system_online_total,
            admin_notes: body.admin_notes,
            verified_by: req.user.id,
            verified_at: new Date().toISOString(),
            status
        }, { onConflict: 'staff_user_id,reconciliation_date' })
            .select()
            .single();
        if (error) {
            res.status(500).json({ error: error.message });
            return;
        }
        res.json({
            data,
            message: status === 'balanced'
                ? 'Cash and online totals match. You may approve pending collections.'
                : 'Discrepancy recorded. Resolve before approving collections.'
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error' });
            return;
        }
        res.status(500).json({ error: 'Reconciliation failed' });
    }
});
// POST /api/collections/payments/:id/approve
router.post('/payments/:id/approve', auth_1.requireAdmin, async (req, res) => {
    const { data: payment } = await supabase_1.supabase
        .from('loan_payments')
        .select('*, loans(loan_code), customers(full_name, phone)')
        .eq('id', req.params.id)
        .single();
    if (!payment || payment.approval_status !== 'pending_admin') {
        res.status(404).json({ error: 'Pending payment not found' });
        return;
    }
    const balanced = await isReconciliationBalanced(payment.created_by, payment.payment_date);
    if (!balanced) {
        res.status(400).json({
            error: 'Daily cash/online reconciliation must be balanced for this staff member before approval'
        });
        return;
    }
    const result = await (0, applyPayment_1.applyLoanPayment)(payment.id, req.user.id);
    if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
    }
    await supabase_1.supabase.from('loan_payments').update({
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    }).eq('id', payment.id);
    // Send SMS Receipt
    if (payment.customers && payment.customers.phone) {
        const message = `Dear ${payment.customers.full_name}, your payment of LKR ${payment.amount} for loan ${payment.loans.loan_code} has been approved. Thank you. GVC Agro Finance.`;
        await (0, sms_1.sendSMS)(payment.customers.phone, message);
    }
    res.json({ message: 'Collection approved and applied to loan' });
});
// POST /api/collections/payments/:id/reject
router.post('/payments/:id/reject', auth_1.requireAdmin, async (req, res) => {
    const { rejection_reason } = req.body;
    const { data, error } = await supabase_1.supabase
        .from('loan_payments')
        .update({
        approval_status: 'rejected',
        rejection_reason: rejection_reason || 'Rejected by admin',
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    })
        .eq('id', req.params.id)
        .eq('approval_status', 'pending_admin')
        .select()
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Pending payment not found' });
        return;
    }
    res.json({ data, message: 'Collection rejected' });
});
// POST /api/collections/savings/:id/approve
router.post('/savings/:id/approve', auth_1.requireAdmin, async (req, res) => {
    const { data: tx } = await supabase_1.supabase
        .from('savings_transactions')
        .select('*')
        .eq('id', req.params.id)
        .single();
    if (!tx || tx.approval_status !== 'pending_admin') {
        res.status(404).json({ error: 'Pending transaction not found' });
        return;
    }
    const balanced = await isReconciliationBalanced(tx.created_by, tx.transaction_date);
    if (!balanced) {
        res.status(400).json({ error: 'Daily reconciliation must be balanced for this staff member first' });
        return;
    }
    const result = await (0, applySavings_1.applySavingsTransaction)(tx.id);
    if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
    }
    await supabase_1.supabase.from('savings_transactions').update({
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    }).eq('id', tx.id);
    res.json({ message: 'Savings entry approved' });
});
// POST /api/collections/savings/:id/reject
router.post('/savings/:id/reject', auth_1.requireAdmin, async (req, res) => {
    const { rejection_reason } = req.body;
    const { data, error } = await supabase_1.supabase
        .from('savings_transactions')
        .update({
        approval_status: 'rejected',
        rejection_reason: rejection_reason || 'Rejected by admin',
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    })
        .eq('id', req.params.id)
        .eq('approval_status', 'pending_admin')
        .select()
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    res.json({ data, message: 'Rejected' });
});
// POST /api/collections/corrections — staff submits mistake letter
router.post('/corrections', requireStaff, async (req, res) => {
    try {
        const body = correctionSchema.parse(req.body);
        const table = body.entity_type === 'loan_payment' ? 'loan_payments' : 'savings_transactions';
        const { data: entity } = await supabase_1.supabase.from(table).select('id, created_by, approval_status').eq('id', body.entity_id).single();
        if (!entity || entity.created_by !== req.user.id) {
            res.status(403).json({ error: 'You can only request corrections for your own entries' });
            return;
        }
        const { data, error } = await supabase_1.supabase
            .from('collection_correction_requests')
            .insert({ ...body, requested_by: req.user.id })
            .select()
            .single();
        if (error) {
            res.status(500).json({ error: error.message });
            return;
        }
        res.status(201).json({ data, message: 'Correction request sent to owner for approval' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to submit correction request' });
    }
});
// GET /api/collections/corrections/pending — owner
router.get('/corrections/pending', auth_1.requireOwner, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('collection_correction_requests')
        .select(`*, requester:requested_by(id, full_name)`)
        .eq('status', 'pending_owner')
        .order('created_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// POST /api/collections/corrections/:id/approve — owner
router.post('/corrections/:id/approve', auth_1.requireOwner, async (req, res) => {
    const { owner_notes } = req.body;
    const { data, error } = await supabase_1.supabase
        .from('collection_correction_requests')
        .update({
        status: 'approved',
        owner_reviewed_by: req.user.id,
        owner_reviewed_at: new Date().toISOString(),
        owner_notes: owner_notes || null
    })
        .eq('id', req.params.id)
        .eq('status', 'pending_owner')
        .select()
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Request not found' });
        return;
    }
    res.json({ data, message: 'Owner approved. Admin may now execute the correction (date/amount can be adjusted).' });
});
// POST /api/collections/corrections/:id/reject — owner
router.post('/corrections/:id/reject', auth_1.requireOwner, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('collection_correction_requests')
        .update({
        status: 'rejected',
        owner_reviewed_by: req.user.id,
        owner_reviewed_at: new Date().toISOString(),
        owner_notes: req.body.owner_notes || 'Rejected'
    })
        .eq('id', req.params.id)
        .eq('status', 'pending_owner')
        .select()
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    res.json({ data, message: 'Correction request rejected' });
});
// POST /api/collections/corrections/:id/execute — admin/owner only (can change date)
router.post('/corrections/:id/execute', requireAdminOrOwner, async (req, res) => {
    try {
        const body = executeCorrectionSchema.parse(req.body);
        const { data: request } = await supabase_1.supabase
            .from('collection_correction_requests')
            .select('*')
            .eq('id', req.params.id)
            .eq('status', 'approved')
            .single();
        if (!request) {
            res.status(404).json({ error: 'Approved correction request not found' });
            return;
        }
        if (request.request_type === 'void' || body.void_only) {
            if (request.entity_type === 'loan_payment') {
                await (0, applyPayment_1.reverseLoanPayment)(request.entity_id, req.user.id);
            }
            else {
                await (0, applySavings_1.reverseSavingsTransaction)(request.entity_id);
            }
        }
        else if (request.request_type === 'amend') {
            const newDate = body.transaction_date || request.proposed_transaction_date;
            const newAmount = body.amount ?? request.proposed_amount;
            const newCash = body.cash_amount ?? request.proposed_cash_amount;
            const newOnline = body.online_amount ?? request.proposed_online_amount;
            if (request.entity_type === 'loan_payment') {
                await (0, applyPayment_1.reverseLoanPayment)(request.entity_id, req.user.id);
                const { data: old } = await supabase_1.supabase.from('loan_payments').select('*').eq('id', request.entity_id).single();
                if (old && newAmount) {
                    const { data: created } = await supabase_1.supabase.from('loan_payments').insert({
                        loan_id: old.loan_id,
                        customer_id: old.customer_id,
                        payment_date: newDate || old.payment_date,
                        amount: newAmount,
                        cash_amount: newCash ?? newAmount,
                        online_amount: newOnline ?? 0,
                        payment_type: old.payment_type,
                        payment_method: old.payment_method,
                        approval_status: 'approved',
                        approved_by: req.user.id,
                        approved_at: new Date().toISOString(),
                        created_by: old.created_by,
                        notes: `Corrected entry. ${request.letter_description}`
                    }).select().single();
                    if (created)
                        await (0, applyPayment_1.applyLoanPayment)(created.id, req.user.id);
                }
            }
            else {
                await (0, applySavings_1.reverseSavingsTransaction)(request.entity_id);
                const { data: old } = await supabase_1.supabase.from('savings_transactions').select('*').eq('id', request.entity_id).single();
                if (old && newAmount) {
                    const { data: created } = await supabase_1.supabase.from('savings_transactions').insert({
                        account_id: old.account_id,
                        customer_id: old.customer_id,
                        transaction_type: old.transaction_type,
                        amount: newAmount,
                        cash_amount: newCash ?? newAmount,
                        online_amount: newOnline ?? 0,
                        transaction_date: newDate || old.transaction_date,
                        payment_method: old.payment_method,
                        description: `Corrected. ${request.letter_description}`,
                        approval_status: 'approved',
                        approved_by: req.user.id,
                        approved_at: new Date().toISOString(),
                        created_by: old.created_by,
                        balance_after: old.balance_after
                    }).select().single();
                    if (created)
                        await (0, applySavings_1.applySavingsTransaction)(created.id);
                }
            }
        }
        await supabase_1.supabase.from('collection_correction_requests').update({
            status: 'executed',
            executed_by: req.user.id,
            executed_at: new Date().toISOString()
        }).eq('id', request.id);
        res.json({ message: 'Correction executed successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error' });
            return;
        }
        res.status(500).json({ error: 'Failed to execute correction' });
    }
});
// GET /api/collections/corrections/approved — admin/owner execute queue
router.get('/corrections/approved', requireAdminOrOwner, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('collection_correction_requests')
        .select(`*, requester:requested_by(id, full_name)`)
        .eq('status', 'approved')
        .order('owner_reviewed_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// GET /api/collections/daily-dues — staff (or admin) collection list for a date
router.get('/daily-dues', async (req, res) => {
    const date = req.query.date || (0, date_fns_1.format)(new Date(), 'yyyy-MM-dd');
    let staffId = req.query.staff_id;
    if (req.user?.role === 'staff') {
        staffId = req.user.id;
    }
    if (!staffId && req.user?.role === 'staff') {
        res.status(400).json({ error: 'Staff ID required' });
        return;
    }
    let query = supabase_1.supabase
        .from('loan_schedule')
        .select(`
      id, installment_number, due_date, installment_amount, paid_amount, status,
      loans!inner(
        id, loan_code, repayment_frequency, credit_date, first_collection_date,
        in_charge_user_id, customer_id, installment_amount,
        customers(id, customer_code, full_name, phone, address, assigned_staff_id)
      )
    `)
        .eq('due_date', date)
        .in('status', ['pending', 'partial', 'overdue']);
    const { data: scheduleRows, error } = await query;
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    let items = (scheduleRows || []).map((row) => ({
        schedule_id: row.id,
        installment_number: row.installment_number,
        due_date: row.due_date,
        amount_due: Number(row.installment_amount) - Number(row.paid_amount || 0),
        installment_amount: row.installment_amount,
        status: row.status,
        loan_id: row.loans.id,
        loan_code: row.loans.loan_code,
        repayment_frequency: row.loans.repayment_frequency,
        customer: row.loans.customers,
        staff_id: row.loans.in_charge_user_id
    }));
    if (staffId) {
        items = items.filter(i => i.staff_id === staffId);
    }
    const totalDue = items.reduce((s, i) => s + i.amount_due, 0);
    res.json({
        data: {
            date,
            staff_id: staffId || null,
            total_customers: items.length,
            total_amount_due: Math.round(totalDue * 100) / 100,
            collections: items.sort((a, b) => a.customer?.full_name?.localeCompare(b.customer?.full_name || '') || 0)
        }
    });
});
// GET /api/collections/my-submissions — staff views own pending
router.get('/my-submissions', requireStaff, async (req, res) => {
    const { data: payments } = await supabase_1.supabase
        .from('loan_payments')
        .select(`*, loans(loan_code), customers(full_name)`)
        .eq('created_by', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
    const { data: savings } = await supabase_1.supabase
        .from('savings_transactions')
        .select(`*, savings_accounts(account_code)`)
        .eq('created_by', req.user.id)
        .order('created_at', { ascending: false })
        .limit(50);
    res.json({ data: { payments: payments || [], savings: savings || [] } });
});
exports.default = router;
//# sourceMappingURL=collections.js.map