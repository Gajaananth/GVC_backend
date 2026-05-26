import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';
import { z } from 'zod';

const router = Router();
router.use(authenticateJWT);

// GET /api/settings
router.get('/', async (_req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('company_settings')
    .select('*')
    .limit(1)
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data });
});

const settingsSchema = z.object({
  company_name: z.string().optional(),
  company_address: z.string().optional(),
  company_phone: z.string().optional(),
  company_email: z.string().email().optional(),
  company_logo_url: z.string().optional(),
  default_loan_interest_rate: z.number().optional(),
  default_savings_interest_rate: z.number().optional(),
  late_fee_percentage: z.number().optional(),
  grace_period_days: z.number().int().optional(),
  sms_enabled: z.boolean().optional(),
  email_enabled: z.boolean().optional()
});

// PUT /api/settings
router.put('/', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = settingsSchema.parse(req.body);
    const { data, error } = await supabase
      .from('company_settings')
      .update({ ...body, updated_by: req.user!.id })
      .neq('id', '00000000-0000-0000-0000-000000000000') // update all rows
      .select()
      .single();

    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ data, message: 'Settings updated successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
