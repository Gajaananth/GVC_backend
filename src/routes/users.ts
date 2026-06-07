import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, requireOwnerOrBranchManager, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(2),
  role: z.enum(['owner', 'branch_manager', 'admin', 'cashier', 'staff', 'view_only']),
  mobile: z.string().optional(),
  address: z.string().optional(),
  branch_id: z.string().uuid().optional() // Owner may omit
});

const updateUserSchema = createUserSchema.partial().omit({ password: true }).extend({
  password: z.string().min(8).optional(),
  is_active: z.boolean().optional(),
  branch_id: z.string().uuid().optional()
});

// GET /api/users - list all users (owner all branches, others own branch only)
router.get('/', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  let query = supabase
    .from('users')
    .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at, branch_id')
    .order('created_at', { ascending: false });

  if (req.user?.role !== 'owner') {
    query = query.eq('branch_id', req.user?.branch_id);
  }

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

// GET /api/users/me - current user profile
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('users')
    .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at')
    .eq('id', req.user!.id)
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

// GET /api/users/:id
router.get('/:id', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('users')
    .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, last_login_at, created_at, branch_id')
    .eq('id', req.params.id)
    .single();

  if (error || !data) { res.status(404).json({ error: 'User not found' }); return; }
  if (req.user?.role !== 'owner' && data.branch_id !== req.user?.branch_id) {
    res.status(403).json({ error: 'Access to user denied for your branch' });
    return;
  }
  res.json({ data });
});

// POST /api/users - create user (owner or branch manager)
router.post('/', requireOwnerOrBranchManager, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createUserSchema.parse(req.body);

    if (body.role !== 'owner' && !body.branch_id) {
      if (req.user!.role === 'branch_manager') {
        body.branch_id = req.user!.branch_id;
      } else {
        res.status(400).json({ error: 'Branch selection is required for non-owner users' });
        return;
      }
    }

    if (body.role === 'owner' && body.branch_id) {
      res.status(400).json({ error: 'Owner cannot be assigned to a branch' });
      return;
    }

    if (req.user!.role === 'branch_manager') {
      if (!['admin', 'cashier', 'staff', 'view_only'].includes(body.role)) {
        res.status(403).json({ error: 'Branch managers can only create admin, cashier, staff, or view-only users' });
        return;
      }
      if (body.branch_id && body.branch_id !== req.user!.branch_id) {
        res.status(403).json({ error: 'Branch managers can only create users for their own branch' });
        return;
      }
      body.branch_id = req.user!.branch_id;
    }

    const branchId = body.branch_id ?? null;
    if (body.role !== 'owner' && !branchId) {
      res.status(400).json({ error: 'Branch selection is required for non-owner users' });
      return;
    }

    if (body.role === 'branch_manager') {
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', branchId)
        .eq('role', 'branch_manager')
        .eq('is_active', true);
      if ((count || 0) > 0) {
        res.status(400).json({ error: 'This branch already has an active manager' });
        return;
      }
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert({
        email: body.email.toLowerCase(),
        password_hash: passwordHash,
        full_name: body.full_name,
        role: body.role,
        mobile: body.mobile,
        address: body.address,
        branch_id: branchId,
        created_by: req.user!.id
      })
      .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'Email already exists' });
      } else {
        res.status(500).json({ error: error.message });
      }
      return;
    }

    // Audit log
    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'CREATE',
      entity_type: 'user',
      entity_id: data.id,
      entity_code: data.user_code,
      description: `Created user: ${data.full_name} (${data.role})`
    });

    res.status(201).json({ data, message: 'User created successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id - update user
router.put('/:id', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = updateUserSchema.parse(req.body);
    const { data: existingUser, error: existingError } = await supabase
      .from('users')
      .select('id, role, branch_id, is_active')
      .eq('id', req.params.id)
      .single();

    if (existingError || !existingUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (req.user!.role !== 'owner' && existingUser.branch_id !== req.user!.branch_id) {
      res.status(403).json({ error: 'Cannot update users outside your branch' });
      return;
    }

    if (body.role && req.user!.role !== 'owner') {
      res.status(403).json({ error: 'Only the owner can change user roles' });
      return;
    }

    if (req.user!.role === 'branch_manager' && body.branch_id && body.branch_id !== req.user!.branch_id) {
      res.status(403).json({ error: 'Branch managers can only assign users to their own branch' });
      return;
    }

    const updateData: Record<string, unknown> = { ...body };
    if (body.password) {
      updateData.password_hash = await bcrypt.hash(body.password, 10);
      delete updateData.password;
    }

    if (body.branch_id) {
      updateData.branch_id = body.branch_id;
    }

    if ((body.role === 'branch_manager' || existingUser.role === 'branch_manager') && updateData.is_active !== false) {
      const branchToCheck = body.branch_id || existingUser.branch_id;
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', branchToCheck)
        .eq('role', 'branch_manager')
        .eq('is_active', true)
        .neq('id', existingUser.id);
      if ((count || 0) > 0) {
        res.status(400).json({ error: 'This branch already has an active manager' });
        return;
      }
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.params.id)
      .select('id, user_code, email, full_name, role, mobile, address, avatar_url, is_active, branch_id')
      .single();

    if (error || !data) { res.status(404).json({ error: 'User not found' }); return; }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'UPDATE',
      entity_type: 'user',
      entity_id: data.id,
      entity_code: data.user_code,
      description: `Updated user: ${data.full_name}`
    });

    res.json({ data, message: 'User updated successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id - deactivate user (owner only, cannot delete self)
router.delete('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: 'Cannot deactivate your own account' });
    return;
  }

  const { data, error } = await supabase
    .from('users')
    .update({ is_active: false })
    .eq('id', req.params.id)
    .select('id, user_code, full_name')
    .single();

  if (error || !data) { res.status(404).json({ error: 'User not found' }); return; }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'DELETE',
    entity_type: 'user',
    entity_id: data.id,
    entity_code: data.user_code,
    description: `Deactivated user: ${data.full_name}`
  });

  res.json({ message: 'User deactivated successfully' });
});

export default router;
