import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireRole, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticateJWT);

const requireStaff = requireRole('staff');

const submitSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  walk_in_full_name: z.string().min(2).optional().nullable(),
  walk_in_nic: z.string().optional().nullable(),
  walk_in_phone: z.string().optional().nullable(),
  form_type: z.enum(['new_customer', 'new_loan', 'both', 'other']),
  staff_notes: z.string().min(10)
}).refine(
  d => d.customer_id || d.walk_in_full_name,
  { message: 'Select existing customer or enter walk-in name' }
);

// POST /api/forms/submit — staff hands physical form to admin
router.post('/submit', requireStaff, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = submitSchema.parse(req.body);

    const { data, error } = await supabase
      .from('physical_form_submissions')
      .insert({
        ...body,
        submitted_by: req.user!.id,
        status: 'pending_admin',
        branch_id: req.user!.branch_id
      })
      .select(`
        *,
        customers(id, customer_code, full_name),
        submitter:submitted_by(id, full_name)
      `)
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'SUBMIT',
      entity_type: 'physical_form',
      entity_id: data.id,
      description: `Staff submitted physical form to admin (${body.form_type})`,
      branch_id: req.user!.branch_id
    });

    res.status(201).json({
      data,
      message: 'Physical form submitted to admin. Admin will enter details and send to owner for approval.'
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.errors[0]?.message || 'Validation error' });
      return;
    }
    res.status(500).json({ error: 'Failed to submit form' });
  }
});

// GET /api/forms/pending — admin/owner
router.get('/pending', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  let pendingQuery = supabase
    .from('physical_form_submissions')
    .select(`
      *,
      customers(id, customer_code, full_name, phone, nic_number),
      submitter:submitted_by(id, full_name)
    `)
    .eq('status', 'pending_admin');

  // Apply branch isolation for non-owner roles
  if (req.user?.role !== 'owner') {
    pendingQuery = pendingQuery.eq('branch_id', req.user?.branch_id);
  }

  const { data, error } = await pendingQuery.order('created_at', { ascending: false });

  if (error) {
    logger.error('Supabase error on forms/pending:', error);
    res.status(500).json({
      error: error.message || 'Failed to load pending physical forms',
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    return;
  }
  res.json({ data });
});

// POST /api/forms/:id/process — admin marked as entered in system
router.post('/:id/process', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { admin_notes } = req.body;

  const { data, error } = await supabase
    .from('physical_form_submissions')
    .update({
      status: 'processed',
      processed_by: req.user!.id,
      processed_at: new Date().toISOString(),
      admin_notes: admin_notes || 'Customer/loan data entered and sent for owner approval'
    })
    .eq('id', req.params.id)
    .eq('status', 'pending_admin')
    .select()
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Pending form not found' });
    return;
  }

  res.json({ data, message: 'Marked as processed' });
});

// GET /api/forms/my — staff own submissions
router.get('/my', requireStaff, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('physical_form_submissions')
    .select(`*, customers(id, customer_code, full_name)`)
    .eq('submitted_by', req.user!.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

export default router;
