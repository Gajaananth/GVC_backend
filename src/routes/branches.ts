import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireOwner, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const createBranchSchema = z.object({
  branch_code: z.string().min(2).max(20),
  branch_name: z.string().min(3),
  address: z.string().min(5),
  phone: z.string().min(9),
  email: z.string().email(),
  status: z.enum(['active', 'inactive']).optional().default('active')
});

const updateBranchSchema = createBranchSchema.partial();

// GET /api/branches - list branches
// Owner: all branches, Branch Manager/Admin/Cashier: own branch only, Staff: own branch only
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let query = supabase
      .from('branches')
      .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
      .order('branch_name', { ascending: true });

    // Non-owners see only their branch
    if (req.user?.role !== 'owner') {
      query = query.eq('id', req.user!.branch_id);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/branches/:id - get single branch
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { data: branch, error } = await supabase
      .from('branches')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !branch) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    // Enforce branch isolation for non-owners
    if (req.user?.role !== 'owner' && branch.id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Access to branch denied' });
      return;
    }

    res.json({ data: branch });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/branches - create branch (owner only)
router.post('/', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createBranchSchema.parse(req.body);

    const { data, error } = await supabase
      .from('branches')
      .insert({
        branch_code: body.branch_code.toUpperCase(),
        branch_name: body.branch_name,
        address: body.address,
        phone: body.phone,
        email: body.email.toLowerCase(),
        status: body.status
      })
      .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'Branch code already exists' });
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
      branch_id: data.id,
      action: 'CREATE',
      entity_type: 'branch',
      entity_id: data.id,
      entity_code: data.branch_code,
      description: `Created branch: ${data.branch_name}`
    });

    res.status(201).json({ data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// PUT /api/branches/:id - update branch (owner only)
router.put('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('branches')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    const body = updateBranchSchema.parse(req.body);

    const { data, error } = await supabase
      .from('branches')
      .update({
        ...(body.branch_code && { branch_code: body.branch_code.toUpperCase() }),
        ...(body.branch_name && { branch_name: body.branch_name }),
        ...(body.address && { address: body.address }),
        ...(body.phone && { phone: body.phone }),
        ...(body.email && { email: body.email.toLowerCase() }),
        ...(body.status && { status: body.status })
      })
      .eq('id', req.params.id)
      .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Audit log
    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      branch_id: req.params.id,
      action: 'UPDATE',
      entity_type: 'branch',
      entity_id: data.id,
      entity_code: data.branch_code,
      description: `Updated branch: ${data.branch_name}`
    });

    res.json({ data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// DELETE /api/branches/:id - delete branch (owner only)
// Only allowed if no users or customers belong to this branch
router.delete('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Check if branch has active users (excluding owner)
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .neq('role', 'owner');

    if (usersError) {
      res.status(500).json({ error: usersError.message });
      return;
    }

    if (users && users.length > 0) {
      res.status(409).json({ 
        error: 'Cannot delete branch with active users',
        userCount: users.length
      });
      return;
    }

    // Check if branch has active customers
    const { data: customers, error: customersError } = await supabase
      .from('customers')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .eq('is_active', true);

    if (customersError) {
      res.status(500).json({ error: customersError.message });
      return;
    }

    if (customers && customers.length > 0) {
      res.status(409).json({ 
        error: 'Cannot delete branch with active customers',
        customerCount: customers.length
      });
      return;
    }

    // Get branch info before deletion for audit
    const { data: branch, error: fetchError } = await supabase
      .from('branches')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !branch) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    // Delete branch
    const { error: deleteError } = await supabase
      .from('branches')
      .delete()
      .eq('id', req.params.id);

    if (deleteError) {
      res.status(500).json({ error: deleteError.message });
      return;
    }

    // Audit log
    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      branch_id: req.params.id,
      action: 'DELETE',
      entity_type: 'branch',
      entity_id: req.params.id,
      entity_code: branch.branch_code,
      description: `Deleted branch: ${branch.branch_name}`
    });

    res.json({ message: 'Branch deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/branches/:id/stats - branch statistics
router.get('/:id/stats', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Enforce branch isolation for non-owners
    if (req.user?.role !== 'owner' && req.params.id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Get branch managers
    const { data: managers, error: managersError } = await supabase
      .from('users')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .eq('role', 'branch_manager');

    // Get active users
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .eq('is_active', true);

    // Get active customers
    const { data: customers, error: customersError } = await supabase
      .from('customers')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .eq('is_active', true);

    // Get active loans
    const { data: loans, error: loansError } = await supabase
      .from('loans')
      .select('id', { count: 'exact' })
      .eq('branch_id', req.params.id)
      .eq('status', 'active');

    if (managersError || usersError || customersError || loansError) {
      res.status(500).json({ error: 'Failed to fetch branch statistics' });
      return;
    }

    res.json({
      data: {
        managers: managers?.length || 0,
        users: users?.length || 0,
        customers: customers?.length || 0,
        activeLoans: loans?.length || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
