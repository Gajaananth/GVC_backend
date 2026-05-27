"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
// GET /api/due/today
router.get('/today', async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('v_today_dues')
        .select('*')
        .order('customer_name', { ascending: true });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// GET /api/due/overdue
router.get('/overdue', async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('v_overdue_loans')
        .select('*')
        .order('days_overdue', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// GET /api/due/upcoming?days=7
router.get('/upcoming', async (req, res) => {
    const days = parseInt(req.query.days || '7', 10);
    const today = new Date();
    const future = new Date();
    future.setDate(future.getDate() + days);
    const { data, error } = await supabase_1.supabase
        .from('loan_schedule')
        .select(`*, loans(loan_code, customers(full_name, customer_code, phone))`)
        .gte('due_date', today.toISOString().split('T')[0])
        .lte('due_date', future.toISOString().split('T')[0])
        .in('status', ['pending', 'partial'])
        .order('due_date', { ascending: true });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// POST /api/due/auto-update-status - detect and mark overdue loans
router.post('/auto-update-status', async (_req, res) => {
    const today = new Date().toISOString().split('T')[0];
    // Mark schedule items as overdue
    const { data: overdueSchedule } = await supabase_1.supabase
        .from('loan_schedule')
        .update({ status: 'overdue' })
        .lt('due_date', today)
        .in('status', ['pending', 'partial'])
        .select('loan_id');
    // Mark loans as overdue
    if (overdueSchedule && overdueSchedule.length > 0) {
        const loanIds = [...new Set(overdueSchedule.map(s => s.loan_id))];
        await supabase_1.supabase
            .from('loans')
            .update({ status: 'overdue' })
            .in('id', loanIds)
            .eq('status', 'active');
    }
    res.json({ message: 'Loan statuses updated', updated: overdueSchedule?.length || 0 });
});
exports.default = router;
//# sourceMappingURL=due.js.map