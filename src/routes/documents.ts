import { Router, Response } from 'express';
import PDFDocument from 'pdfkit';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';
import { format } from 'date-fns';
import { getCompanySettings } from '../config/companyConfig';
import ExcelJS from 'exceljs';
import { addStandardHeader, drawTable, PDFTableColumn } from '../utils/pdfTableGenerator';

import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticateJWT);

// Helper function to generate PDF headers with logo
const addHeader = (doc: PDFKit.PDFDocument, title: string, settings: any) => {
  const logoPath = path.join(process.cwd(), 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, (doc.page.width - 80) / 2, doc.y, { width: 80 });
    doc.y += 85;
  }

  doc.fontSize(22).font('Helvetica-Bold').fillColor('#166534').text(settings.company_name, { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#000000').text(settings.company_address, { align: 'center' });
  doc.text(`Tel: ${settings.company_phone} | Email: ${settings.company_email}`, { align: 'center' });
  doc.moveDown(1.5);
  doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
  doc.moveDown(1);
};

// GET /api/documents/receipt/:payment_id
router.get('/receipt/:payment_id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const { data: payment } = await supabase
      .from('loan_payments')
      .select('*, loans(loan_code), customers(full_name, nic_number, customer_code)')
      .eq('id', req.params.payment_id)
      .single();

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Branch isolation
    if (user.role !== 'owner' && payment.branch_id !== user.branch_id) {
      res.status(403).json({ error: 'Access to payment denied for your branch' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment.payment_code}.pdf`);

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    addHeader(doc, 'OFFICIAL PAYMENT RECEIPT', settings);

    // Box for receipt info
    doc.rect(50, doc.y, 500, 70).stroke('#e5e7eb');
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text(`Receipt No: ${payment.payment_code}`, 60);
    doc.font('Helvetica').text(`Date: ${format(new Date(payment.payment_date), 'yyyy-MM-dd')}`, 60);
    doc.text(`Customer Code: ${payment.customers.customer_code}`, 60);
    doc.moveDown(2);

    // Customer Info
    doc.font('Helvetica-Bold').text('Customer Details:');
    doc.font('Helvetica').text(`Name: ${payment.customers.full_name}`);
    doc.text(`Loan Account: ${payment.loans.loan_code}`);
    doc.moveDown(1.5);

    // Payment details table
    doc.font('Helvetica-Bold').text('Payment Details:');
    const tableTop = doc.y + 5;

    // Table Header
    doc.rect(50, tableTop, 500, 20).fillAndStroke('#f3f4f6', '#d1d5db');
    doc.fillColor('#374151').font('Helvetica-Bold');
    doc.text('Description', 60, tableTop + 5);
    doc.text('Method', 250, tableTop + 5);
    doc.text('Amount (LKR)', 400, tableTop + 5, { width: 140, align: 'right' });

    // Table Row
    const rowTop = tableTop + 20;
    doc.rect(50, rowTop, 500, 30).stroke('#d1d5db');
    doc.fillColor('#000000').font('Helvetica');
    doc.text(payment.payment_type.toUpperCase(), 60, rowTop + 10);
    doc.text(payment.payment_method.toUpperCase(), 250, rowTop + 10);
    doc.font('Helvetica-Bold').text(Number(payment.amount).toFixed(2), 400, rowTop + 10, { width: 140, align: 'right' });

    if (payment.notes) {
      doc.moveDown(2);
      doc.font('Helvetica-Oblique').text(`Notes: ${payment.notes}`);
    }

    // Footer signatures
    doc.moveDown(5);
    const sigY = doc.y;
    doc.font('Helvetica').text('........................................', 50, sigY);
    doc.text('Customer Signature', 50, sigY + 15);

    doc.text('........................................', 350, sigY);
    doc.text('Authorized Signature', 350, sigY + 15);

    doc.moveDown(4);
    doc.fontSize(10).fillColor('#6b7280').text('Thank you for your payment. This is a computer generated document and requires no stamp.', { align: 'center' });

    doc.end();
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// GET /api/documents/statement/:customer_id
router.get('/statement/:customer_id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('id', req.params.customer_id)
      .single();

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Branch isolation
    if (user.role !== 'owner' && customer.branch_id !== user.branch_id) {
      res.status(403).json({ error: 'Access to customer denied for your branch' });
      return;
    }

    const { data: loans } = await supabase
      .from('loans')
      .select('*, loan_payments(*)')
      .eq('customer_id', customer.id);

    const { data: savings } = await supabase
      .from('savings_accounts')
      .select('*')
      .eq('customer_id', customer.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=statement-${customer.customer_code}.pdf`);

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    addHeader(doc, 'CUSTOMER ACCOUNT STATEMENT', settings);

    doc.fontSize(11).font('Helvetica-Bold').text(`Customer Name: ${customer.full_name}`);
    doc.font('Helvetica').text(`Customer Code: ${customer.customer_code}`);
    doc.text(`NIC: ${customer.nic_number}`);
    doc.text(`Date Generated: ${format(new Date(), 'yyyy-MM-dd')}`);
    doc.moveDown(2);

    if (savings && savings.length > 0) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#166534').text('Savings Accounts');
      doc.fillColor('#000000');
      doc.moveDown(0.5);
      savings.forEach(acc => {
        doc.fontSize(11).font('Helvetica-Bold').text(`Account: ${acc.account_code}`);
        doc.font('Helvetica').text(`Current Balance: LKR ${Number(acc.balance).toFixed(2)}`);
        doc.moveDown(1);
      });
      doc.moveDown(1);
    }

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#166534').text('Loan Accounts');
    doc.fillColor('#000000');
    doc.moveDown(0.5);

    if (loans && loans.length > 0) {
      loans.forEach(loan => {
        doc.fontSize(12).font('Helvetica-Bold').text(`Loan: ${loan.loan_code} - ${loan.status.toUpperCase()}`);
        doc.fontSize(11).font('Helvetica').text(`Principal Amount: LKR ${Number(loan.principal_amount).toFixed(2)}`);
        doc.text(`Remaining Balance: LKR ${Number(loan.remaining_balance).toFixed(2)}`);
        doc.moveDown(0.5);

        doc.font('Helvetica-Bold').text('Payment History:');
        if (loan.loan_payments && loan.loan_payments.length > 0) {
          doc.font('Helvetica');
          loan.loan_payments
            .filter((p: any) => p.approval_status === 'approved')
            .sort((a: any, b: any) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime())
            .forEach((p: any) => {
              doc.text(`  • ${format(new Date(p.payment_date), 'yyyy-MM-dd')}: LKR ${Number(p.amount).toFixed(2)} (${p.payment_type}) - ${p.payment_code}`);
          });
        } else {
          doc.font('Helvetica-Oblique').text('  No payments recorded.');
        }
        doc.moveDown(1.5);
      });
    } else {
      doc.font('Helvetica-Oblique').text('No loans found for this customer.');
    }

    doc.moveDown(2);
    doc.fontSize(10).fillColor('#6b7280').text('This is a computer generated statement.', { align: 'center' });
    doc.end();
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate statement' });
  }
});

// GET /api/documents/loan-certificate/:loan_id
router.get('/loan-certificate/:loan_id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const { data: loan } = await supabase
      .from('loans')
      .select('*, customers(full_name, nic_number, customer_code)')
      .eq('id', req.params.loan_id)
      .single();

    if (!loan || loan.status !== 'closed' || !loan.is_fully_paid) {
      res.status(400).json({ error: 'Loan is not fully settled' });
      return;
    }

    // Branch isolation
    if (user.role !== 'owner' && loan.branch_id !== user.branch_id) {
      res.status(403).json({ error: 'Access to loan denied for your branch' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=certificate-${loan.loan_code}.pdf`);

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 50, layout: 'landscape' });
    doc.pipe(res);

    // Border
    doc.rect(30, 30, doc.page.width - 60, doc.page.height - 60).stroke('#166534');
    doc.rect(35, 35, doc.page.width - 70, doc.page.height - 70).lineWidth(2).stroke('#166534');

    doc.moveDown(3);
    doc.fontSize(30).font('Helvetica-Bold').fillColor('#166534').text(settings.company_name, { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#000000').text(settings.company_address, { align: 'center' });

    doc.moveDown(3);
    doc.fontSize(24).font('Helvetica-Bold').text('LOAN SETTLEMENT CERTIFICATE', { align: 'center', underline: true });

    doc.moveDown(3);
    doc.fontSize(14).font('Helvetica');
    doc.text(`This is to certify that `, { continued: true, align: 'center' });
    doc.font('Helvetica-Bold').text(`${loan.customers.full_name}`, { continued: true });
    doc.font('Helvetica').text(` (NIC: ${loan.customers.nic_number})`);

    doc.moveDown();
    doc.text(`has successfully settled the loan account `, { continued: true, align: 'center' });
    doc.font('Helvetica-Bold').text(`${loan.loan_code}`, { continued: true });
    doc.font('Helvetica').text(` in full.`);

    doc.moveDown();
    doc.text(`Loan Amount: LKR ${Number(loan.principal_amount).toFixed(2)}`, { align: 'center' });
    doc.text(`Settlement Date: ${format(new Date(loan.last_payment_date || new Date()), 'yyyy-MM-dd')}`, { align: 'center' });

    doc.moveDown(4);
    const sigY = doc.y;
    doc.font('Helvetica').text('........................................', 500, sigY);
    doc.text('Authorized Signature', 500, sigY + 15);
    doc.text('GVC Agro Finance', 500, sigY + 30);

    doc.end();
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate certificate' });
  }
});

// GET /api/documents/loan-schedule/:id/pdf
router.get('/loan-schedule/:id/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const { data: loan } = await supabase
      .from('loans')
      .select('*, customers(full_name, nic_number, customer_code)')
      .eq('id', req.params.id)
      .single();

    if (!loan) { res.status(404).json({ error: 'Loan not found' }); return; }

    // Branch isolation
    if (user.role !== 'owner' && loan.branch_id !== user.branch_id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { data: schedule } = await supabase
      .from('loan_schedule')
      .select('*')
      .eq('loan_id', loan.id)
      .order('installment_number', { ascending: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=schedule-${loan.loan_code}.pdf`);

    const settings = await getCompanySettings();
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    doc.pipe(res);

    addStandardHeader(doc, 'LOAN SCHEDULE REPORT', settings, `Loan: ${loan.loan_code} | Customer: ${loan.customers.full_name}`);
    doc.moveDown(1);
    
    // Customer and Loan details summary
    doc.fontSize(10).font('Helvetica-Bold').text(`Customer Code:`, 30, doc.y, { continued: true }).font('Helvetica').text(` ${loan.customers.customer_code}`);
    doc.font('Helvetica-Bold').text(`Principal:`, 30, doc.y, { continued: true }).font('Helvetica').text(` ${Number(loan.principal_amount).toFixed(2)} LKR`);
    doc.font('Helvetica-Bold').text(`Status:`, 30, doc.y, { continued: true }).font('Helvetica').text(` ${loan.status.toUpperCase()}`);
    doc.moveDown(2);

    const columns: PDFTableColumn[] = [
      { header: '#', key: 'installment_number', width: 30 },
      { header: 'Due Date', key: 'due_date', width: 80 },
      { header: 'Due Amount', key: 'installment_amount', width: 80, align: 'right' },
      { header: 'Status', key: 'status', width: 70 },
      { header: 'Paid Date', key: 'paid_date', width: 80 },
      { header: 'Paid Amount', key: 'paid_amount', width: 80, align: 'right' }
    ];

    const rows = (schedule || []).map((s: any) => ({
      installment_number: s.installment_number,
      due_date: s.due_date ? format(new Date(s.due_date), 'yyyy-MM-dd') : '',
      installment_amount: Number(s.installment_amount).toFixed(2),
      status: String(s.status).toUpperCase(),
      paid_date: s.paid_date ? format(new Date(s.paid_date), 'yyyy-MM-dd') : '-',
      paid_amount: s.paid_amount > 0 ? Number(s.paid_amount).toFixed(2) : '-'
    }));

    drawTable(doc, columns, rows, settings, 'LOAN SCHEDULE REPORT', `Loan: ${loan.loan_code} | Customer: ${loan.customers.full_name}`);
    
    doc.end();
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate schedule pdf' });
  }
});

// GET /api/documents/loan-schedule/:id/excel
router.get('/loan-schedule/:id/excel', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    const { data: loan } = await supabase
      .from('loans')
      .select('*, customers(full_name, nic_number, customer_code)')
      .eq('id', req.params.id)
      .single();

    if (!loan) { res.status(404).json({ error: 'Loan not found' }); return; }

    // Branch isolation
    if (user.role !== 'owner' && loan.branch_id !== user.branch_id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { data: schedule } = await supabase
      .from('loan_schedule')
      .select('*')
      .eq('loan_id', loan.id)
      .order('installment_number', { ascending: true });

    const settings = await getCompanySettings();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Loan Schedule');

    sheet.columns = [
      { header: '#', key: 'no', width: 5 },
      { header: 'Due Date', key: 'dueDate', width: 15 },
      { header: 'Due Amount', key: 'dueAmount', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Paid Date', key: 'paidDate', width: 15 },
      { header: 'Paid Amount', key: 'paidAmount', width: 15 }
    ];

    sheet.insertRow(1, [settings.company_name]);
    sheet.insertRow(2, [settings.company_address]);
    sheet.insertRow(3, [`Loan: ${loan.loan_code} | Customer: ${loan.customers.full_name}`]);
    sheet.insertRow(4, []);
    
    // Header style
    sheet.getRow(1).font = { bold: true, size: 16 };
    sheet.getRow(3).font = { bold: true };

    (schedule || []).forEach((s: any) => {
      sheet.addRow({
        no: s.installment_number,
        dueDate: s.due_date ? format(new Date(s.due_date), 'yyyy-MM-dd') : '',
        dueAmount: Number(s.installment_amount),
        status: String(s.status).toUpperCase(),
        paidDate: s.paid_date ? format(new Date(s.paid_date), 'yyyy-MM-dd') : '-',
        paidAmount: s.paid_amount > 0 ? Number(s.paid_amount) : '-'
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=schedule-${loan.loan_code}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate schedule excel' });
  }
});

export default router;