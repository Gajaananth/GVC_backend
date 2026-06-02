import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';
import { sendSMS } from '../utils/sms';

const router = Router();
router.use(authenticateJWT);

const smsSchema = z.object({
  customer_id: z.string().uuid(),
  message: z.string().min(5).max(160)
});

// POST /api/notifications/send-sms
router.post('/send-sms', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { customer_id, message } = smsSchema.parse(req.body);

    const { data: customer } = await supabase
      .from('customers')
      .select('phone, full_name')
      .eq('id', customer_id)
      .single();

    if (!customer || !customer.phone) {
      res.status(400).json({ error: 'Customer not found or no phone number available' });
      return;
    }

    // Call the sms utility
    await sendSMS(customer.phone, message);

    // Log the manual SMS to due_reminders table (reusing it as a generic notification log for simplicity)
    await supabase.from('due_reminders').insert({
      customer_id,
      due_date: new Date().toISOString().split('T')[0], // Just use today as a placeholder
      status: 'sent',
      sent_at: new Date().toISOString()
    });

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'SEND_SMS',
      entity_type: 'customer',
      entity_id: customer_id,
      description: `Sent manual SMS to ${customer.full_name}: "${message}"`
    });

    res.json({ message: 'SMS sent successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error' });
      return;
    }
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// GET /api/notifications/history
router.get('/history', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('due_reminders')
    .select('*, customers(full_name, phone)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch notification history' });
    return;
  }

  res.json({ data });
});

export default router;
