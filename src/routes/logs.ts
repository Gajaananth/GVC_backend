import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);
router.use(requireAdmin);

// GET /api/logs - paginated activity logs with filters
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { user_id, action, entity_type, start_date, end_date, page = '1', limit = '50' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('activity_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (user_id) query = query.eq('user_id', user_id);
  if (action) query = query.eq('action', action);
  if (entity_type) query = query.eq('entity_type', entity_type);
  if (start_date) query = query.gte('created_at', start_date);
  if (end_date) query = query.lte('created_at', `${end_date}T23:59:59`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

export default router;
