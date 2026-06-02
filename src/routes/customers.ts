import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireCustomerAdmin, AuthRequest } from '../middleware/auth';

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
  home_photo_url: z.string().optional().nullable(),
  shop_photo_url: z.string().optional().nullable(),
  application_form_url: z.string().optional().nullable(),
  registered_by_staff_id: z.string().uuid().optional().nullable(),
  assigned_staff_id: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable()
});

// GET /api/customers — all roles (staff = view only)
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('customers')
    .select('*, loans(id, loan_code, status, remaining_balance, approval_status), assigned_staff:assigned_staff_id(id, full_name)', { count: 'exact' })
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

// GET /api/customers/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: customer, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !customer) { res.status(404).json({ error: 'Customer not found' }); return; }

  const { data: loans } = await supabase
    .from('loans')
    .select(`
      id, loan_code, principal_amount, remaining_balance, status, approval_status,
      start_date, end_date, next_due_date,
      applied_by_user:applied_by(id, full_name),
      in_charge_user:in_charge_user_id(id, full_name)
    `)
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  const { data: savings } = await supabase
    .from('savings_accounts')
    .select('id, account_code, account_type, balance, interest_rate, is_active')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  const { data: documents } = await supabase
    .from('customer_documents')
    .select('id, document_type, file_url, file_name, uploaded_at')
    .eq('customer_id', req.params.id)
    .order('uploaded_at', { ascending: false });

  res.json({ data: { ...customer, loans: loans || [], savings: savings || [], documents: documents || [] } });
});

// POST /api/customers — admin/owner only (staff cannot create)
router.post('/', requireCustomerAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = customerSchema.parse(req.body);
    const { registered_by_staff_id, assigned_staff_id, ...customerFields } = body;
    const staffId = assigned_staff_id || registered_by_staff_id;

    if (staffId) {
      const { data: staff } = await supabase
        .from('users')
        .select('id, role')
        .eq('id', staffId)
        .single();
      if (!staff || !['staff', 'admin'].includes(staff.role)) {
        res.status(400).json({ error: 'Invalid staff member for assignment' });
        return;
      }
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({
        ...customerFields,
        registered_by_staff_id: registered_by_staff_id || staffId || null,
        assigned_staff_id: staffId || null,
        created_by: req.user!.id
      })
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

// PUT /api/customers/:id — admin/owner only
router.put('/:id', requireCustomerAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = customerSchema.partial().parse(req.body);
    const { registered_by_staff_id: _omit, ...updateFields } = body;

    const { data, error } = await supabase
      .from('customers')
      .update({ ...updateFields, updated_by: req.user!.id })
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

// DELETE /api/customers/:id — admin/owner only
router.delete('/:id', requireCustomerAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: activeLoans } = await supabase
    .from('loans')
    .select('id')
    .eq('customer_id', req.params.id)
    .in('status', ['active', 'overdue', 'pending_approval'])
    .limit(1);

  if (activeLoans && activeLoans.length > 0) {
    res.status(400).json({ error: 'Cannot delete customer with active or pending loans' });
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

router.get('/:id/loans', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('loans')
    .select('*, loan_payments(count)')
    .eq('customer_id', req.params.id)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

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
