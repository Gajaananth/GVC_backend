import { Router, Response } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireAdmin, requireOwner, AuthRequest } from '../middleware/auth';
import { getCompanySettings, addStandardHeader } from '../utils/pdfTableGenerator';

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
  const { status, customer_id, branch_id, search, page = '1', limit = '10' } = req.query;
  
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('fixed_deposits')
    .select(`
      *,
      customers(id, full_name, customer_code, nic_number),
      branches(id, branch_name)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (status) query = query.eq('status', status);
  if (customer_id) query = query.eq('customer_id', customer_id);

  // Apply branch isolation
  if (req.user?.role !== 'owner') {
    query = query.eq('branch_id', req.user?.branch_id);
  } else if (branch_id) {
    query = query.eq('branch_id', branch_id);
  }

  if (search) {
    const safeSearch = (search as string).replace(/"/g, '');
    query = query.ilike('fd_code', `%${safeSearch}%`);
  }

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  
  res.json({ 
    data, 
    total: count, 
    page: pageNum, 
    limit: limitNum, 
    totalPages: Math.ceil((count || 0) / limitNum) 
  });
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

    // Fetch the customer to get their branch_id
    const { data: customer } = await supabase
      .from('customers')
      .select('branch_id')
      .eq('id', body.customer_id)
      .single();

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const branchId = customer.branch_id;

    const isOwner = req.user!.role === 'owner';
    const status = isOwner ? 'active' : 'pending';
    const approvedBy = isOwner ? req.user!.id : null;
    const approvedAt = isOwner ? new Date().toISOString() : null;

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
        status: status,
        payout_method: body.payout_method,
        total_maturity_amount: totalMaturityAmount,
        notes: body.notes,
        created_by: req.user!.id,
        approved_by: approvedBy,
        approved_at: approvedAt
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
      description: `Created fixed deposit ${data.fd_code} for ${body.principal_amount}${isOwner ? ' (Auto-approved)' : ''}`
    });

    res.status(201).json({ 
      data, 
      message: isOwner ? 'Fixed deposit created successfully' : 'Fixed deposit created and awaiting approval' 
    });
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

  const payout_amount = req.body.payout_amount != null ? Number(req.body.payout_amount) : Number(fd.total_maturity_amount);
  const reason = req.body.notes || 'Maturity/Early Withdrawal';
  const closed_at = new Date().toISOString();

  let newNotes = fd.notes ? fd.notes + '\n' : '';
  newNotes += `[CLOSED] Payout Amount: ${payout_amount}. Reason: ${reason}`;

  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({
      status: 'closed',
      payout_amount,
      closure_reason: reason,
      closed_at,
      notes: newNotes
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
    description: 'Closed fixed deposit ' + data.fd_code
  });

  res.json({ data, message: 'Fixed deposit closed successfully' });
});

// GET /api/fixed-deposits/:id/closure-certificate
router.get('/:id/closure-certificate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { data: fd } = await supabase
      .from('fixed_deposits')
      .select('*, customers(full_name, nic_number, address)')
      .eq('id', req.params.id)
      .single();

    if (!fd) { res.status(404).json({ error: 'Fixed deposit not found' }); return; }

    if (fd.status !== 'closed') {
      res.status(400).json({ error: 'Closure certificate can only be generated for closed fixed deposits' });
      return;
    }

    if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Access denied to this closure certificate' });
      return;
    }

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=FD-Closure-Certificate-${fd.fd_code}.pdf`);
    doc.pipe(res);

    addStandardHeader(doc, 'FIXED DEPOSIT CLOSURE CERTIFICATE', settings);
    doc.moveDown(2);

    doc.fontSize(12).font('Helvetica').fillColor('#000000');
    doc.text(`This is to certify that `, { continued: true });
    doc.font('Helvetica-Bold').text(fd.customers.full_name, { continued: true });
    doc.font('Helvetica').text(` (NIC: ${fd.customers.nic_number})`);
    doc.text(`residing at ${fd.customers.address || '___________________________'}`);

    doc.moveDown(1);
    doc.text(`Has closed the fixed deposit with us under the following details:`);
    doc.moveDown(1);

    const startX = 50;
    let currY = doc.y;
    const boxHeight = 240;
    doc.rect(startX, currY, doc.page.width - 100, boxHeight).stroke('#cccccc');

    currY += 20;
    doc.font('Helvetica-Bold').text('Certificate No:', startX + 20, currY);
    doc.font('Helvetica').text(fd.fd_code, startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Deposit Date:', startX + 20, currY);
    doc.font('Helvetica').text(new Date(fd.created_at).toLocaleDateString(), startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Closure Date:', startX + 20, currY);
    doc.font('Helvetica').text(new Date(fd.closed_at || new Date().toISOString()).toLocaleDateString(), startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Term (Months):', startX + 20, currY);
    doc.font('Helvetica').text(`${fd.term_months} Months`, startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Interest Rate:', startX + 20, currY);
    doc.font('Helvetica').text(`${fd.interest_rate}% p.a.`, startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Maturity Date:', startX + 20, currY);
    doc.font('Helvetica').text(new Date(fd.maturity_date).toLocaleDateString(), startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Original Maturity Value:', startX + 20, currY);
    doc.font('Helvetica').text(`${settings.currency_symbol} ${Number(fd.total_maturity_amount).toLocaleString()}`, startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Actual Payout Amount:', startX + 20, currY);
    doc.font('Helvetica').text(`${settings.currency_symbol} ${Number(fd.payout_amount || fd.total_maturity_amount).toLocaleString()}`, startX + 170, currY);

    const penalty = Number(fd.total_maturity_amount) - Number(fd.payout_amount || fd.total_maturity_amount);
    currY += 25;
    doc.font('Helvetica-Bold').text('Early Closure Penalty:', startX + 20, currY);
    doc.font('Helvetica').text(`${settings.currency_symbol} ${penalty > 0 ? penalty.toLocaleString() : '0.00'}`, startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Payout Method:', startX + 20, currY);
    doc.font('Helvetica').text(fd.payout_method.replace('_', ' '), startX + 170, currY);

    currY += 25;
    doc.font('Helvetica-Bold').text('Closure Reason:', startX + 20, currY);
    doc.font('Helvetica').text(fd.closure_reason || 'Maturity/Early Withdrawal', startX + 170, currY, { width: doc.page.width - 260 });

    doc.y = currY + 45;
    doc.moveDown(2);

    const sigY = doc.page.height - 150;
    doc.font('Helvetica').text('_________________________', 60, sigY);
    doc.text('Authorized Signature (Owner)', 60, sigY + 18);

    doc.text('_________________________', doc.page.width - 260, sigY);
    doc.text('Customer Signature', doc.page.width - 260, sigY + 18);

    doc.end();
  } catch (err) {
    console.error('Closure PDF Generation Error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate closure PDF' });
  }
});

// POST /api/fixed-deposits/:id/block
router.post('/:id/block', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { reason } = req.body;
  
  const { data: fd } = await supabase
    .from('fixed_deposits')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!fd) {
    res.status(404).json({ error: 'Fixed deposit not found' });
    return;
  }

  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({
      is_blocked: true,
      block_reason: reason || 'Blocked by admin'
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
    description: `Blocked fixed deposit ${data.fd_code}. Reason: ${reason || 'Blocked by admin'}`
  });

  res.json({ data, message: 'Fixed deposit blocked successfully' });
});

// POST /api/fixed-deposits/:id/unblock
router.post('/:id/unblock', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: fd } = await supabase
    .from('fixed_deposits')
    .select('*')
    .eq('id', req.params.id)
    .eq('is_blocked', true)
    .single();

  if (!fd) {
    res.status(404).json({ error: 'Blocked fixed deposit not found' });
    return;
  }

  const { data, error } = await supabase
    .from('fixed_deposits')
    .update({
      is_blocked: false,
      block_reason: null
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
    description: `Unblocked fixed deposit ${data.fd_code}`
  });

  res.json({ data, message: 'Fixed deposit unblocked successfully' });
});

// GET /api/fixed-deposits/:id/certificate
router.get('/:id/certificate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { data: fd } = await supabase
      .from('fixed_deposits')
      .select('*, customers(full_name, nic_number, address)')
      .eq('id', req.params.id)
      .single();

    if (!fd) { res.status(404).json({ error: 'Fixed deposit not found' }); return; }

    // Authorization check: user must be owner, admin, or belong to the FD's branch
    if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
      res.status(403).json({ error: 'Access denied to this certificate' });
      return;
    }

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=FD-Certificate-${fd.fd_code}.pdf`);
    doc.pipe(res);

    addStandardHeader(doc, 'FIXED DEPOSIT CERTIFICATE', settings);

    doc.moveDown(2);
    
    // Certificate Content
    doc.fontSize(12).font('Helvetica').fillColor('#000000');
    doc.text(`This is to certify that `, { continued: true });
    doc.font('Helvetica-Bold').text(fd.customers.full_name, { continued: true });
    doc.font('Helvetica').text(` (NIC: ${fd.customers.nic_number})`);
    doc.text(`residing at ${fd.customers.address || '___________________________'}`);
    
    doc.moveDown(1);
    doc.text(`Has deposited the sum of `, { continued: true });
    doc.font('Helvetica-Bold').text(`${settings.currency_symbol} ${Number(fd.principal_amount).toLocaleString()}`, { continued: true });
    doc.font('Helvetica').text(` as a Fixed Deposit with us.`);
    
    doc.moveDown(1.5);
    
    // Details Box
    const startX = 50;
    let currY = doc.y;
    doc.rect(startX, currY, doc.page.width - 100, 160).stroke('#cccccc');
    
    currY += 20;
    doc.font('Helvetica-Bold').text('Certificate No:', startX + 20, currY);
    doc.font('Helvetica').text(fd.fd_code, startX + 150, currY);
    
    currY += 25;
    doc.font('Helvetica-Bold').text('Deposit Date:', startX + 20, currY);
    doc.font('Helvetica').text(new Date(fd.created_at).toLocaleDateString(), startX + 150, currY);
    
    currY += 25;
    doc.font('Helvetica-Bold').text('Term (Months):', startX + 20, currY);
    doc.font('Helvetica').text(`${fd.term_months} Months`, startX + 150, currY);
    
    currY += 25;
    doc.font('Helvetica-Bold').text('Interest Rate:', startX + 20, currY);
    doc.font('Helvetica').text(`${fd.interest_rate}% p.a.`, startX + 150, currY);
    
    currY += 25;
    doc.font('Helvetica-Bold').text('Maturity Date:', startX + 20, currY);
    doc.font('Helvetica').text(new Date(fd.maturity_date).toLocaleDateString(), startX + 150, currY);
    
    currY += 25;
    doc.font('Helvetica-Bold').text('Maturity Value:', startX + 20, currY);
    doc.font('Helvetica').text(`${settings.currency_symbol} ${Number(fd.total_maturity_amount).toLocaleString()}`, startX + 150, currY);
    
    doc.y = currY + 40;
    doc.moveDown(2);
    
    // Signatures
    const sigY = doc.page.height - 150;
    doc.font('Helvetica').text('_________________________', 50, sigY);
    doc.text('Authorized Signature (Owner)', 50, sigY + 15);
    
    doc.text('_________________________', doc.page.width - 250, sigY);
    doc.text('Customer Signature', doc.page.width - 250, sigY + 15);

    doc.end();
  } catch (err) {
    console.error('PDF Generation Error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;
