import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireOwner, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const branchSchema = z.object({
  branch_code: z.string().min(2),
  branch_name: z.string().min(2),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const updateBranchSchema = branchSchema.partial();

router.get('/', requireOwner, async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('branches')
    .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data });
});

router.get('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
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

router.post('/', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = branchSchema.parse(req.body);
    const insertData = {
      ...body,
      status: body.status ?? 'active',
    };

    const { data, error } = await supabase
      .from('branches')
      .insert(insertData)
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

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'CREATE',
      entity_type: 'branch',
      entity_id: data.id,
      entity_code: data.branch_code,
      description: `Created branch: ${data.branch_name}`,
    });

    res.status(201).json({ data, message: 'Branch created successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

router.put('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = updateBranchSchema.parse(req.body);

    const { data, error } = await supabase
      .from('branches')
      .update(body)
      .eq('id', req.params.id)
      .select('id, branch_code, branch_name, address, phone, email, status, created_at, updated_at')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Branch not found or could not be updated' });
      return;
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'UPDATE',
      entity_type: 'branch',
      entity_id: data.id,
      entity_code: data.branch_code,
      description: `Updated branch: ${data.branch_name}`,
    });

    res.json({ data, message: 'Branch updated successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    res.status(500).json({ error: 'Failed to update branch' });
  }
});

router.delete('/:id', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const branchId = req.params.id;

  const [{ count: customerCount }, { count: loanCount }] = await Promise.all([
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
    supabase.from('loans').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
  ]);

  if ((customerCount || 0) > 0 || (loanCount || 0) > 0) {
    res.status(400).json({ error: 'Cannot delete a branch with active customers or loans' });
    return;
  }

  const { data, error } = await supabase
    .from('branches')
    .delete()
    .eq('id', branchId)
    .select('id, branch_code, branch_name')
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Branch not found or could not be deleted' });
    return;
  }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'DELETE',
    entity_type: 'branch',
    entity_id: data.id,
    entity_code: data.branch_code,
    description: `Deleted branch: ${data.branch_name}`,
  });

  res.json({ message: 'Branch deleted successfully' });
});

router.get('/:id/stats', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const branchId = req.params.id;

  const [{ count: managerCount }, { count: userCount }, { count: customerCount }, { count: activeLoanCount }] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('role', 'branch_manager').eq('is_active', true),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('is_active', true),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('branch_id', branchId),
    supabase.from('loans').select('id', { count: 'exact', head: true }).eq('branch_id', branchId).eq('status', 'active'),
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

export default router;
