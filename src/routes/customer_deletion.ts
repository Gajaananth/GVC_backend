import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireOwner, AuthRequest } from '../middleware/auth';
import PDFDocument from 'pdfkit';
import { getCompanySettings } from '../utils/pdfTableGenerator';

const router = Router();
router.use(authenticateJWT);

// Owner only for deletion endpoints
router.use(requireOwner);

// GET /api/customers/:id/archive-data
router.get('/:id/archive-data', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const customerId = req.params.id;
    const { data: customer } = await supabase.from('customers').select('*').eq('id', customerId).single();
    if (!customer) { res.status(404).json({ error: 'Customer not found' }); return; }

    const { data: loans } = await supabase.from('loans').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    const { data: payments } = await supabase.from('loan_payments').select('*').eq('customer_id', customerId).order('payment_date', { ascending: false });
    const { data: schedules } = await supabase.from('loan_schedule').select('*').in('loan_id', (loans || []).map((l: any) => l.id)).order('installment_number', { ascending: true });
    const { data: fds } = await supabase.from('fixed_deposits').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    const { data: documents } = await supabase.from('customer_documents').select('*').eq('customer_id', customerId).order('uploaded_at', { ascending: false });

    res.json({ data: { customer, loans: loans || [], payments: payments || [], schedules: schedules || [], fixedDeposits: fds || [], documents: documents || [] } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch archive data' });
  }
});

// POST /api/customers/:id/generate-archive-pdf -> streams PDF
router.post('/:id/generate-archive-pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const customerId = req.params.id;
    const { data: customer } = await supabase.from('customers').select('*').eq('id', customerId).single();
    if (!customer) { res.status(404).json({ error: 'Customer not found' }); return; }

    // Gather related data (limited for performance)
    const { data: loans } = await supabase.from('loans').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    const { data: payments } = await supabase.from('loan_payments').select('*').eq('customer_id', customerId).order('payment_date', { ascending: false });
    const loanIds = (loans || []).map((l: any) => l.id);
    const { data: schedules } = loanIds.length > 0
      ? await supabase.from('loan_schedule').select('*').in('loan_id', loanIds).order('loan_id', { ascending: true }).order('installment_number', { ascending: true })
      : { data: [] };
    const { data: fds } = await supabase.from('fixed_deposits').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
    const { data: documents } = await supabase.from('customer_documents').select('*').eq('customer_id', customerId).order('uploaded_at', { ascending: false });

    const settings = await getCompanySettings();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=customer-archive-${customerId}.pdf`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(settings.company_name, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(settings.company_address, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').text(`Customer Archive - ${customer.full_name}`);
    doc.fontSize(9).font('Helvetica').text(`Customer ID: ${customer.id}  |  NIC: ${customer.nic_number}  |  Generated: ${new Date().toISOString()}`);
    doc.moveDown(1);

    // Basic info
    doc.fontSize(10).font('Helvetica-Bold').text('Customer Information');
    doc.fontSize(9).font('Helvetica').text(`Name: ${customer.full_name}`);
    doc.text(`NIC: ${customer.nic_number}`);
    doc.text(`Phone: ${customer.phone}`);
    doc.text(`Address: ${customer.address}`);
    doc.text(`Assigned Staff: ${customer.assigned_staff_id || 'N/A'}`);
    doc.moveDown(0.5);

    // Loans
    doc.fontSize(10).font('Helvetica-Bold').text('Loans');
    (loans || []).forEach((loan: any) => {
      doc.fontSize(9).font('Helvetica-Bold').text(`${loan.loan_code} - ${loan.status}`);
      doc.fontSize(9).font('Helvetica').text(`Amount: ${loan.principal_amount}  Interest: ${loan.interest_rate}  Term: ${loan.duration_months}`);
      doc.moveDown(0.25);
    });
    doc.moveDown(0.5);

    // Payments
    doc.fontSize(10).font('Helvetica-Bold').text('Payment History');
    (payments || []).slice(0, 500).forEach((p: any) => {
      doc.fontSize(9).font('Helvetica').text(`${p.payment_date} - ${p.payment_code} - ${p.amount} - ${p.payment_method || ''} - ${p.notes || ''}`);
    });

    doc.moveDown(0.5);
    // FD
    doc.fontSize(10).font('Helvetica-Bold').text('Fixed Deposits');
    (fds || []).forEach((fd: any) => {
      doc.fontSize(9).font('Helvetica').text(`${fd.fd_code} - ${fd.status} - ${fd.principal_amount} - Maturity: ${fd.maturity_date}`);
    });

    doc.end();
  } catch (err) {
    console.error('Archive PDF generation error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate archive PDF' });
  }
});

// DELETE /api/customers/:id/delete-permanently
router.delete('/:id/delete-permanently', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const customerId = req.params.id;
    const { deletion_reason } = req.body || {};

    // Prevent deletion if active loans exist
    const { data: activeLoans } = await supabase.from('loans').select('id').eq('customer_id', customerId).in('status', ['active', 'overdue', 'pending_approval']).limit(1);
    if (activeLoans && activeLoans.length > 0) { res.status(400).json({ error: 'Cannot delete customer with active or pending loans' }); return; }

    // Sequence deletions (best-effort)
    // 1) payments
    await supabase.from('loan_payments').delete().eq('customer_id', customerId);
    // 2) loan schedule entries and loans
    const { data: loans } = await supabase.from('loans').select('id').eq('customer_id', customerId);
    const loanIds = (loans || []).map((l:any)=>l.id);
    if (loanIds.length > 0) {
      await supabase.from('loan_schedule').delete().in('loan_id', loanIds);
      await supabase.from('loans').delete().in('id', loanIds);
    }
    // 3) fixed deposits
    await supabase.from('fixed_deposits').delete().eq('customer_id', customerId);
    // 4) documents
    await supabase.from('customer_documents').delete().eq('customer_id', customerId);
    // 5) savings accounts & transactions
    const { data: savings } = await supabase.from('savings_accounts').select('id').eq('customer_id', customerId);
    const savingIds = (savings||[]).map((s:any)=>s.id);
    if (savingIds.length > 0) await supabase.from('savings_transactions').delete().in('account_id', savingIds);
    await supabase.from('savings_accounts').delete().eq('customer_id', customerId);
    // 6) finally customer
    await supabase.from('customers').delete().eq('id', customerId);

    // audit log
    await supabase.from('activity_logs').insert({
      user_id: req.user!.id,
      user_name: req.user!.full_name,
      user_role: req.user!.role,
      action: 'DELETE',
      entity_type: 'customer',
      entity_id: customerId,
      description: `Permanent delete by ${req.user!.full_name}. Reason: ${deletion_reason || 'N/A'}`
    });

    res.json({ data: { deletedRecords: { customer: 1 } }, message: 'Customer deleted permanently' });
  } catch (err) {
    console.error('Permanent deletion failed', err);
    res.status(500).json({ error: 'Failed to delete customer permanently' });
  }
});

export default router;
