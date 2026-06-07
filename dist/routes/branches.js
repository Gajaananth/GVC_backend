"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const branchSchema = zod_1.z.object({
    branch_code: zod_1.z.string().min(2),
    branch_name: zod_1.z.string().min(2),
    address: zod_1.z.string().optional(),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    status: zod_1.z.enum(['active', 'inactive']).optional(),
});
const updateBranchSchema = branchSchema.partial();
router.get('/', auth_1.requireOwner, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('branches')
        .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
        .order('created_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
router.get('/:id', auth_1.requireOwner, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('branches')
        .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
        .eq('id', req.params.id)
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Branch not found' });
        return;
    }
    res.json({ data });
});
router.post('/', auth_1.requireOwner, async (req, res) => {
    try {
        const body = branchSchema.parse(req.body);
        const insertData = {
            ...body,
            status: body.status ?? 'active',
        };
        const { data, error } = await supabase_1.supabase
            .from('branches')
            .insert(insertData)
            .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
            .single();
        if (error) {
            if (error.code === '23505') {
                res.status(409).json({ error: 'Branch code already exists' });
            }
            else {
                res.status(500).json({ error: error.message });
            }
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'CREATE',
            entity_type: 'branch',
            entity_id: data.id,
            entity_code: data.branch_code,
            description: `Created branch: ${data.branch_name}`,
        });
        res.status(201).json({ data, message: 'Branch created successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to create branch' });
    }
});
router.put('/:id', auth_1.requireOwner, async (req, res) => {
    try {
        const body = updateBranchSchema.parse(req.body);
        const { data, error } = await supabase_1.supabase
            .from('branches')
            .update(body)
            .eq('id', req.params.id)
            .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
            .single();
        if (error || !data) {
            res.status(404).json({ error: 'Branch not found or could not be updated' });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'UPDATE',
            entity_type: 'branch',
            entity_id: data.id,
            entity_code: data.branch_code,
            description: `Updated branch: ${data.branch_name}`,
        });
        res.json({ data, message: 'Branch updated successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to update branch' });
    }
});
router.delete('/:id', auth_1.requireOwner, async (req, res) => {
    const branchId = req.params.id;
    const [{ count: customerCount }, { count: loanCount }] = await Promise.all([
        supabase_1.supabase.from('customers').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
        supabase_1.supabase.from('loans').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
    ]);
    if ((customerCount || 0) > 0 || (loanCount || 0) > 0) {
        res.status(400).json({ error: 'Cannot delete a branch with active customers or loans' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('branches')
        .delete()
        .eq('id', branchId)
        .select('id, branch_code, branch_name')
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Branch not found or could not be deleted' });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'DELETE',
        entity_type: 'branch',
        entity_id: data.id,
        entity_code: data.branch_code,
        description: `Deleted branch: ${data.branch_name}`,
    });
    res.json({ message: 'Branch deleted successfully' });
});
router.get('/:id/stats', auth_1.requireOwner, async (req, res) => {
    const branchId = req.params.id;
    const [{ count: managerCount }, { count: userCount }, { count: customerCount }, { count: activeLoanCount }] = await Promise.all([
        supabase_1.supabase.from('users').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('role', 'branch_manager').eq('is_active', true),
        supabase_1.supabase.from('users').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('is_active', true),
        supabase_1.supabase.from('customers').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
        supabase_1.supabase.from('loans').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('status', 'active'),
    ]);
    res.json({
        data: {
            managers: managerCount || 0,
            users: userCount || 0,
            customers: customerCount || 0,
            activeLoans: activeLoanCount || 0,
        },
    });
});
exports.default = router;
//# sourceMappingURL=branches.js.map