"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const sms_1 = require("../utils/sms");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const smsSchema = zod_1.z.object({
    customer_id: zod_1.z.string().uuid(),
    message: zod_1.z.string().min(5).max(160)
});
// POST /api/notifications/send-sms
router.post('/send-sms', auth_1.requireAdmin, async (req, res) => {
    try {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        const { customer_id, message } = smsSchema.parse(req.body);
        const { data: customer } = await supabase_1.supabase
            .from('customers')
            .select('phone, full_name')
            .eq('id', customer_id)
            .single();
        if (!customer || !customer.phone) {
            res.status(400).json({ error: 'Customer not found or no phone number available' });
            return;
        }
        // Branch isolation
        if (user.role !== 'owner' && customer.branch_id !== user.branch_id) {
            res.status(403).json({ error: 'Access to customer denied for your branch' });
            return;
        }
        // Call the sms utility
        await (0, sms_1.sendSMS)(customer.phone, message);
        // Log the manual SMS to due_reminders table (reusing it as a generic notification log for simplicity)
        await supabase_1.supabase.from('due_reminders').insert({
            customer_id,
            due_date: new Date().toISOString().split('T')[0], // Just use today as a placeholder
            status: 'sent',
            sent_at: new Date().toISOString()
        });
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: user.id,
            user_name: user.full_name,
            user_role: user.role,
            action: 'SEND_SMS',
            entity_type: 'customer',
            entity_id: customer_id,
            description: `Sent manual SMS to ${customer.full_name}: "${message}"`
        });
        res.json({ message: 'SMS sent successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error' });
            return;
        }
        res.status(500).json({ error: 'Failed to send SMS' });
    }
});
// GET /api/notifications/history
router.get('/history', auth_1.requireAdmin, async (req, res) => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    // Use local user for branch filtering
    if (user.role !== 'owner') {
        const resp = await supabase_1.supabase
            .from('due_reminders')
            .select('*, customers(full_name, phone)')
            .order('created_at', { ascending: false })
            .eq('customers.branch_id', user.branch_id)
            .limit(100);
        if (resp.error) {
            res.status(500).json({ error: 'Failed to fetch notification history' });
            return;
        }
        res.json({ data: resp.data });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('due_reminders')
        .select('*, customers(full_name, phone)')
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) {
        res.status(500).json({ error: 'Failed to fetch notification history' });
        return;
    }
    res.json({ data });
});
exports.default = router;
//# sourceMappingURL=notifications.js.map