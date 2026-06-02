"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const date_fns_1 = require("date-fns");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const applyPayment_1 = require("../utils/applyPayment");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const recordPaymentSchema = zod_1.z.object({
    loan_id: zod_1.z.string().uuid(),
    payment_date: zod_1.z.string().optional(),
    amount: zod_1.z.number().positive(),
    cash_amount: zod_1.z.number().min(0).optional(),
    online_amount: zod_1.z.number().min(0).optional(),
    payment_type: zod_1.z.enum(['regular', 'partial', 'full_settlement', 'advance']),
    payment_method: zod_1.z.enum(['cash', 'bank_transfer', 'cheque', 'mobile']).default('cash'),
    reference_number: zod_1.z.string().optional().nullable(),
    notes: zod_1.z.string().optional().nullable()
});
// GET /api/payments
router.get('/', async (req, res) => {
    const { loan_id, customer_id, start_date, end_date, approval_status, page = '1', limit = '20' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const offset = (pageNum - 1) * limitNum;
    let query = supabase_1.supabase
        .from('loan_payments')
        .select(`*, loans(loan_code), customers(full_name, customer_code)`, { count: 'exact' })
        .order('payment_date', { ascending: false })
        .range(offset, offset + limitNum - 1);
    if (loan_id)
        query = query.eq('loan_id', loan_id);
    if (customer_id)
        query = query.eq('customer_id', customer_id);
    if (start_date)
        query = query.gte('payment_date', start_date);
    if (end_date)
        query = query.lte('payment_date', end_date);
    if (approval_status)
        query = query.eq('approval_status', approval_status);
    const { data, error, count } = await query;
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});
// POST /api/payments — admin/owner only, immediate approval (staff use /api/collections/submit/payment)
router.post('/', auth_1.requireAdmin, async (req, res) => {
    try {
        const body = recordPaymentSchema.parse(req.body);
        const paymentDate = body.payment_date || (0, date_fns_1.format)(new Date(), 'yyyy-MM-dd');
        const cashAmount = body.cash_amount ?? (body.payment_method === 'cash' ? body.amount : 0);
        const onlineAmount = body.online_amount ?? (body.payment_method !== 'cash' ? body.amount : 0);
        const { data: loan } = await supabase_1.supabase
            .from('loans')
            .select('*, customers(id, full_name)')
            .eq('id', body.loan_id)
            .single();
        if (!loan) {
            res.status(404).json({ error: 'Loan not found' });
            return;
        }
        if (loan.approval_status !== 'approved' || loan.status === 'pending_approval') {
            res.status(400).json({ error: 'Payments only on owner-approved loans' });
            return;
        }
        if (loan.is_fully_paid) {
            res.status(400).json({ error: 'Loan is already fully paid' });
            return;
        }
        if (body.amount > loan.remaining_balance + 1) {
            res.status(400).json({ error: `Amount exceeds remaining balance` });
            return;
        }
        const { data: payment, error: payError } = await supabase_1.supabase
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
            approved_by: req.user.id,
            approved_at: new Date().toISOString(),
            created_by: req.user.id
        })
            .select()
            .single();
        if (payError || !payment) {
            res.status(500).json({ error: payError?.message });
            return;
        }
        const result = await (0, applyPayment_1.applyLoanPayment)(payment.id, req.user.id);
        if (!result.success) {
            res.status(400).json({ error: result.error });
            return;
        }
        const { data: updatedLoan } = await supabase_1.supabase.from('loans').select('remaining_balance, is_fully_paid').eq('id', body.loan_id).single();
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id, user_name: req.user.full_name, user_role: req.user.role,
            action: 'CREATE', entity_type: 'payment',
            entity_id: payment.id, entity_code: payment.payment_code,
            description: `Admin recorded payment ${payment.payment_code}`
        });
        res.status(201).json({
            data: { ...payment, loan_code: loan.loan_code, new_balance: updatedLoan?.remaining_balance, is_fully_paid: updatedLoan?.is_fully_paid },
            message: updatedLoan?.is_fully_paid ? 'Loan fully settled!' : 'Payment recorded'
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to record payment' });
    }
});
router.get('/:id', async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('loan_payments')
        .select(`*, loans(loan_code, principal_amount, interest_rate, duration_months), customers(full_name, customer_code, nic_number, phone, address)`)
        .eq('id', req.params.id)
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Payment not found' });
        return;
    }
    res.json({ data });
});
exports.default = router;
//# sourceMappingURL=payments.js.map