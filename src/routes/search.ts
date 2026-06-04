import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticateJWT);

// GET /api/search
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q = req.query.q as string;
    if (!q || q.length < 2) {
      res.json({ data: [] });
      return;
    }

    const searchQuery = `%${q}%`;

    // Search Customers
    const safeSearch = (q as string).replace(/"/g, '');
    const { data: customers } = await supabase
      .from('customers')
      .select('id, full_name, nic_number, customer_code, phone, photo_url')
      .or(`full_name.ilike."%${safeSearch}%",nic_number.ilike."%${safeSearch}%",customer_code.ilike."%${safeSearch}%",phone.ilike."%${safeSearch}%"`)
      .limit(5);

    // Search Loans
    const { data: loans } = await supabase
      .from('loans')
      .select('id, loan_code, status, customers(full_name)')
      .ilike('loan_code', searchQuery)
      .limit(5);

    const results = [
      ...(customers || []).map(c => ({
        type: 'customer',
        id: c.id,
        title: c.full_name,
        subtitle: `${c.customer_code} • ${c.nic_number}`,
        link: `/customers/${c.id}`
      })),
      ...(loans || []).map(l => ({
        type: 'loan',
        id: l.id,
        title: l.loan_code,
        subtitle: `Status: ${l.status} • Customer: ${(l as any).customers?.full_name}`,
        link: `/loans/${l.id}`
      }))
    ];

    res.json({ data: results });
  } catch (error: any) {
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
