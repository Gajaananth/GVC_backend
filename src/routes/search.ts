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
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }

    const safeSearch = (q as string).replace(/"/g, '');
    let customersRes = await supabase
      .from('customers')
      .select('id, full_name, nic_number, customer_code, phone, photo_url')
      .or(`full_name.ilike."%${safeSearch}%",nic_number.ilike."%${safeSearch}%",customer_code.ilike."%${safeSearch}%",phone.ilike."%${safeSearch}%"`)
      .limit(5);
    let customers = customersRes.data;
    // Branch / staff scoping
    if (user.role === 'staff') {
      // staff only see assigned customers
      const staffRes = await supabase
        .from('customers')
        .select('id, full_name, nic_number, customer_code, phone, photo_url')
        .or(`full_name.ilike."%${safeSearch}%",nic_number.ilike."%${safeSearch}%",customer_code.ilike."%${safeSearch}%",phone.ilike."%${safeSearch}%"`)
        .eq('assigned_staff_id', user.id)
        .limit(5);
      customers = staffRes.data;
    } else if (user.role !== 'owner') {
      // branch-restricted search
      const branchRes = await supabase
        .from('customers')
        .select('id, full_name, nic_number, customer_code, phone, photo_url')
        .or(`full_name.ilike."%${safeSearch}%",nic_number.ilike."%${safeSearch}%",customer_code.ilike."%${safeSearch}%",phone.ilike."%${safeSearch}%"`)
        .eq('branch_id', user.branch_id)
        .limit(5);
      customers = branchRes.data;
    }

    // Search Loans
    let loansRes = await supabase
      .from('loans')
      .select('id, loan_code, status, customers(full_name)')
      .ilike('loan_code', searchQuery)
      .limit(5);
    let loans = loansRes.data;
    if (user.role !== 'owner') {
      const branchLoansRes = await supabase
        .from('loans')
        .select('id, loan_code, status, customers(full_name)')
        .ilike('loan_code', searchQuery)
        .eq('branch_id', user.branch_id)
        .limit(5);
      loans = branchLoansRes.data;
    }

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
