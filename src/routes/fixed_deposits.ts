import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const createFDSchema = z.object({
  customer_id: z.string().uuid(),
  principal_amount: z.number().positive(),
  interest_rate: z.number().positive(),
  term_months: z.number().int().positive(),
  payout_method: z.enum(['cash', 'bank_transfer', 'cheque']).default('cash'),
  notes: z.string().optional().nullable()
});

// GET /api/fixed-deposits
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { status, customer_id, branch_id } = req.query;

  let query = supabase
    .from('fixed_deposits')
    .select(`
      *,
      customers(id, full_name, customer_code, nic_number),
      branches(id, branch_name)
    `)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (customer_id) query = query.eq('customer_id', customer_id);

  // Apply branch isolation
  if (req.user?.role !== 'owner') {
    query = query.eq('branch_id', req.user?.branch_id);
  } else if (branch_id) {
    query = query.eq('branch_id', branch_id);
  }

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

// GET /api/fixed-deposits/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('fixed_deposits')
    .select(`
      *,
      customers(*),
      branches(*),
      created_by_user:created_by(full_name),
      approved_by_user:approved_by(full_name)
    `)
    .eq('id', req.params.id)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Fixed deposit not found' }); return; }

  if (req.user?.role !== 'owner' && data.branch_id !== req.user?.branch_id) {
    res.status(403).json({ error: 'Access denied to this fixed deposit' });
    return;
  }

  res.json({ data });
});

// POST /api/fixed-deposits
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createFDSchema.parse(req.body);

    const fdCode = 'FD-' + Date.now().toString().slice(-6);
    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + body.term_months);

    // Calculate total maturity amount (simple interest)
    // A = P(1 + rt), where r is annual rate and t is time in years
    const r = body.interest_rate / 100;
    const t = body.term_months / 12;
    const totalMaturityAmount = body.principal_amount * (1 + r * t);

    const branchId = req.user!.branch_id || req.user!.id; // Owner fallback

    const { data, error } = await supabase
      .from('fixed_deposits')
      .insert({
        fd_code: fdCode,
        customer_id: body.customer_id,
        branch_id: branchId,
        principal_amount: body.principal_amount,
        interest_rate: body.interest_rate,
        term_months: body.term_months,
        maturity_date: maturityDate.toISOString().split('T')[0],
        status: 'pending',
        payout_method: body.payout_method,
        total_maturity_amount: totalMaturityAmount,
        notes: body.notes,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (error) { res.status(500).json({ error: error.message }); return; }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'CREATE',
      entity_type: 'fixed_deposit',
      entity_id: data.id,
      entity_code: data.fd_code,
      description: 'Created fixed deposit ' + data.fd_code + ' for ' + body.principal_amount
    });

    res.status(201).json({ data, message: 'Fixed deposit created and awaiting approval' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to create fixed deposit' });
  }
});

// POST /api/fixed-deposits/:id/approve
router.post('/:id/approve', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: fd } = await supabase
    .from('fixed_deposits')
    .select('*, customers(full_name)')
    .eq('id', req.params.id)
    .single();

  if (!fd || fd.status !== 'pending') {
    res.status(404).json({ error: 'Pending fixed deposit not found' });
    return;
  }

  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({
      status: 'active',
      approved_by: req.user!.id,
      approved_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'UPDATE',
    entity_type: 'fixed_deposit',
    entity_id: data.id,
    entity_code: data.fd_code,
    description: 'Approved fixed deposit ' + data.fd_code
  });

  res.json({ data, message: 'Fixed deposit approved successfully' });
});

// POST /api/fixed-deposits/:id/reject
router.post('/:id/reject', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({
      status: 'rejected',
      approved_by: req.user!.id,
      approved_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('status', 'pending')
    .select()
    .single();

  if (error || !data) { res.status(404).json({ error: 'Fixed deposit not found or not pending' }); return; }

  res.json({ data, message: 'Fixed deposit rejected' });
});

// POST /api/fixed-deposits/:id/close
router.post('/:id/close', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  // Only matured or active FDs can be closed
  const { data: fd } = await supabase
    .from('fixed_deposits')
    .select('*')
    .eq('id', req.params.id)
    .in('status', ['active', 'matured'])
    .single();

  if (!fd) {
    res.status(404).json({ error: 'Fixed deposit not found or cannot be closed' });
    return;
  }

  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({ status: 'closed' })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id,
    user_name: req.user!.full_name,
    user_role: req.user!.role,
    action: 'UPDATE',
    entity_type: 'fixed_deposit',
    entity_id: data.id,
    entity_code: data.fd_code,
    description: 'Closed fixed deposit ' + data.fd_code
  });

  res.json({ data, message: 'Fixed deposit closed successfully' });
});

export default router;
