"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const createUserSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
    full_name: zod_1.z.string().min(2),
    role: zod_1.z.enum(['owner', 'branch_manager', 'admin', 'cashier', 'staff', 'view_only']),
    mobile: zod_1.z.string().optional(),
    address: zod_1.z.string().optional(),
    branch_id: zod_1.z.string().uuid().optional() // Owner may omit
});
const updateUserSchema = createUserSchema.partial().omit({ password: true }).extend({
    password: zod_1.z.string().min(8).optional(),
    is_active: zod_1.z.boolean().optional(),
    branch_id: zod_1.z.string().uuid().optional()
});
// GET /api/users - list all users (admin+)
router.get('/', auth_1.requireAdmin, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('users')
        .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at')
        .order('created_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// GET /api/users/me - current user profile
router.get('/me', async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('users')
        .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at')
        .eq('id', req.user.id)
        .single();
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
// GET /api/users/:id
router.get('/:id', auth_1.requireAdmin, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('users')
        .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at')
        .eq('id', req.params.id)
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    res.json({ data });
});
// POST /api/users - create user (owner only)
router.post('/', auth_1.requireOwner, async (req, res) => {
    try {
        const body = createUserSchema.parse(req.body);
        const passwordHash = await bcryptjs_1.default.hash(body.password, 10);
        const { data, error } = await supabase_1.supabase
            .from('users')
            .insert({
            email: body.email.toLowerCase(),
            password_hash: passwordHash,
            full_name: body.full_name,
            role: body.role,
            mobile: body.mobile,
            address: body.address,
            created_by: req.user.id
        })
            .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, created_at')
            .single();
        if (error) {
            if (error.code === '23505') {
                res.status(409).json({ error: 'Email already exists' });
            }
            else {
                res.status(500).json({ error: error.message });
            }
            return;
        }
        // Audit log
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'CREATE',
            entity_type: 'user',
            entity_id: data.id,
            entity_code: data.user_code,
            description: `Created user: ${data.full_name} (${data.role})`
        });
        res.status(201).json({ data, message: 'User created successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to create user' });
    }
});
// PUT /api/users/:id - update user
router.put('/:id', auth_1.requireAdmin, async (req, res) => {
    try {
        const body = updateUserSchema.parse(req.body);
        const updateData = { ...body };
        // Only owner can change roles
        if (body.role && req.user.role !== 'owner') {
            res.status(403).json({ error: 'Only the owner can change user roles' });
            return;
        }
        if (body.password) {
            updateData.password_hash = await bcryptjs_1.default.hash(body.password, 10);
            delete updateData.password;
        }
        const { data, error } = await supabase_1.supabase
            .from('users')
            .update(updateData)
            .eq('id', req.params.id)
            .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active')
            .single();
        if (error || !data) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'UPDATE',
            entity_type: 'user',
            entity_id: data.id,
            entity_code: data.user_code,
            description: `Updated user: ${data.full_name}`
        });
        res.json({ data, message: 'User updated successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to update user' });
    }
});
// DELETE /api/users/:id - deactivate user (owner only, cannot delete self)
router.delete('/:id', auth_1.requireOwner, async (req, res) => {
    if (req.params.id === req.user.id) {
        res.status(400).json({ error: 'Cannot deactivate your own account' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('users')
        .update({ is_active: false })
        .eq('id', req.params.id)
        .select('id, user_code, full_name')
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'DELETE',
        entity_type: 'user',
        entity_id: data.id,
        entity_code: data.user_code,
        description: `Deactivated user: ${data.full_name}`
    });
    res.json({ message: 'User deactivated successfully' });
});
exports.default = router;
//# sourceMappingURL=users.js.map