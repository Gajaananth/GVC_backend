import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireWrite, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

const customerSchema = z.object({
  full_name: z.string().min(2),
  nic_number: z.string().min(9),
  phone: z.string().min(9),
  email: z.string().email().optional().nullable(),
  address: z.string().min(5),
  date_of_birth: z.string().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  occupation: z.string().optional().nullable(),
  monthly_income: z.number().optional().nullable(),
  photo_url: z.string().optional().nullable(),
  nic_front_url: z.string().optional().nullable(),
  nic_back_url: z.string().optional().nullable(),
  notes: z.string().optional().nullable()
});

// GET /api/customers - list with search/filter/pagination
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('customers')
    .select('*, loans(id, loan_code, status, remaining_balance)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,nic_number.ilike.%${search}%,phone.ilike.%${search}%,customer_code.ilike.%${search}%`);
  }

  if (status === 'active') {
    query = query.eq('is_active', true);
  } else if (status === 'inactive') {
    query = query.eq('is_active', false);
  }

  const { data, error, count } = await query;

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// GET /api/customers/:id - single customer with full details
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: customer, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !customer) { res.status(404).json({ error: 'Customer not found' }); return; }

  // Get loans
  const { data: loans } = await supabase
    .from('loans')
    .select('id, loan_code, principal_amount, remaining_balance, status, start_date, end_date, next_due_date')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  // Get savings
  const { data: savings } = await supabase
    .from('savings_accounts')
    .select('id, account_code, account_type, balance, interest_rate, is_active')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  res.json({ data: { ...customer, loans: loans || [], savings: savings || [] } });
});

// POST /api/customers
router.post('/', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = customerSchema.parse(req.body);

    const { data, error } = await supabase
      .from('customers')
      .insert({ ...body, created_by: req.user!.id })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'NIC number already exists' });
      } else {
        res.status(500).json({ error: error.message });
      }
      return;
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'customer',
      entity_id: data.id, entity_code: data.customer_code,
      description: `Created customer: ${data.full_name}`
    });

    res.status(201).json({ data, message: 'Customer created successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT /api/customers/:id
router.put('/:id', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = customerSchema.partial().parse(req.body);

    const { data, error } = await supabase
      .from('customers')
      .update({ ...body, updated_by: req.user!.id })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'UPDATE', entity_type: 'customer',
      entity_id: data.id, entity_code: data.customer_code,
      description: `Updated customer: ${data.full_name}`
    });

    res.json({ data, message: 'Customer updated successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id - soft delete
router.delete('/:id', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  // Check if customer has active loans
  const { data: activeLoans } = await supabase
    .from('loans')
    .select('id')
    .eq('customer_id', req.params.id)
    .eq('status', 'active')
    .limit(1);

  if (activeLoans && activeLoans.length > 0) {
    res.status(400).json({ error: 'Cannot delete customer with active loans' });
    return;
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ is_active: false, updated_by: req.user!.id })
    .eq('id', req.params.id)
    .select('id, customer_code, full_name')
    .single();

  if (error || !data) { res.status(404).json({ error: 'Customer not found' }); return; }

  await supabase.from('activity_logs').insert({
    user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
    action: 'DELETE', entity_type: 'customer',
    entity_id: data.id, entity_code: data.customer_code,
    description: `Deactivated customer: ${data.full_name}`
  });

  res.json({ message: 'Customer deactivated successfully' });
});

// GET /api/customers/:id/loans - customer loan history
router.get('/:id/loans', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loans')
    .select('*, loan_payments(count)')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

// GET /api/customers/:id/savings - customer savings history
router.get('/:id/savings', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('savings_accounts')
    .select('*, savings_transactions(*)')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

export default router;
