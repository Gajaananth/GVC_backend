import { Router, Response } from 'express';
import { z } from 'zod';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { supabase } from '../config/supabase';
import { authenticateJWT, AuthRequest } from '../middleware/auth';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { sendEmail } from '../utils/email';
import { getCompanySettings, addStandardHeader, drawTable, PDFTableColumn } from '../utils/pdfTableGenerator';

const router = Router();
router.use(authenticateJWT);

// GET /api/reports/:type?start_date=&end_date=&customer_id=
router.get('/:type', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type } = req.params;
  const { start_date, end_date, customer_id } = req.query;

  const today = new Date();
  const sDate = (start_date as string) || format(startOfMonth(today), 'yyyy-MM-dd');
  const eDate = (end_date as string) || format(endOfMonth(today), 'yyyy-MM-dd');

  try {
    if (req.user?.role === 'staff' && !['daily_collection', 'customer_wise'].includes(type)) {
      res.status(403).json({ error: 'Staff are only permitted to view daily collections and customer-wise reports' });
      return;
    }

    let reportData: unknown;

    switch (type) {
      case 'daily_collection': {
        let query = supabase
          .from('loan_payments')
          .select(`payment_code, payment_date, amount, payment_type, payment_method, loans!inner(loan_code, branch_id), customers(full_name, customer_code, phone, nic_number)`)
          .gte('payment_date', sDate)
          .lte('payment_date', eDate)
          .order('payment_date', { ascending: false });

        if (req.user?.role !== 'owner') query = query.eq('loans.branch_id', req.user?.branch_id);

        const { data } = await query;
        const total = (data || []).reduce((sum: number, p: any) => sum + p.amount, 0);
        reportData = { payments: data || [], total_collected: total, period: { start: sDate, end: eDate } };
        break;
      }

      case 'monthly_finance': {
        let paymentsQuery = supabase
          .from('loan_payments')
          .select('amount, payment_date, payment_type, loans!inner(branch_id)')
          .gte('payment_date', sDate)
          .lte('payment_date', eDate);
        if (req.user?.role !== 'owner') paymentsQuery = paymentsQuery.eq('loans.branch_id', req.user?.branch_id);
        const { data: payments } = await paymentsQuery;

        let newLoansQuery = supabase
          .from('loans')
          .select('principal_amount, start_date')
          .gte('start_date', sDate)
          .lte('start_date', eDate);
        if (req.user?.role !== 'owner') newLoansQuery = newLoansQuery.eq('branch_id', req.user?.branch_id);
        const { data: newLoans } = await newLoansQuery;

        let savingsQuery = supabase
          .from('savings_transactions')
          .select('amount, transaction_type, transaction_date, savings_accounts!inner(branch_id)')
          .gte('transaction_date', sDate)
          .lte('transaction_date', eDate);
        if (req.user?.role !== 'owner') savingsQuery = savingsQuery.eq('savings_accounts.branch_id', req.user?.branch_id);
        const { data: savings } = await savingsQuery;

        const totalCollections = (payments || []).reduce((s: number, p: any) => s + p.amount, 0);
        const totalDisbursed = (newLoans || []).reduce((s: number, l: any) => s + l.principal_amount, 0);
        const totalDeposits = (savings || []).filter((s: any) => s.transaction_type === 'deposit').reduce((s: number, t: any) => s + t.amount, 0);
        const totalWithdrawals = (savings || []).filter((s: any) => s.transaction_type === 'withdrawal').reduce((s: number, t: any) => s + t.amount, 0);

        reportData = {
          period: { start: sDate, end: eDate },
          loan_collections: totalCollections,
          loans_disbursed: totalDisbursed,
          savings_deposits: totalDeposits,
          savings_withdrawals: totalWithdrawals,
          net_income: totalCollections - totalDisbursed
        };
        break;
      }

      case 'loan_summary': {
        let query = supabase
          .from('loans')
          .select(`*, customers(full_name, customer_code, phone)`)
          .order('created_at', { ascending: false });
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;

        const summary = {
          total: (data || []).length,
          active: (data || []).filter((l: any) => l.status === 'active').length,
          closed: (data || []).filter((l: any) => l.status === 'closed').length,
          overdue: (data || []).filter((l: any) => l.status === 'overdue').length,
          total_disbursed: (data || []).reduce((s: number, l: any) => s + l.principal_amount, 0),
          total_outstanding: (data || []).filter((l: any) => l.status !== 'closed').reduce((s: number, l: any) => s + l.remaining_balance, 0)
        };
        reportData = { loans: data, summary };
        break;
      }

      case 'savings_summary': {
        let query = supabase
          .from('savings_accounts')
          .select(`*, customers(full_name, customer_code, phone)`)
          .order('created_at', { ascending: false });
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;

        const summary = {
          total_accounts: (data || []).length,
          active_accounts: (data || []).filter((a: any) => a.is_active).length,
          total_balance: (data || []).reduce((s: number, a: any) => s + a.balance, 0),
          total_deposited: (data || []).reduce((s: number, a: any) => s + a.total_deposited, 0),
          total_withdrawn: (data || []).reduce((s: number, a: any) => s + a.total_withdrawn, 0),
          total_interest_earned: (data || []).reduce((s: number, a: any) => s + a.total_interest_earned, 0)
        };
        reportData = { accounts: data, summary };
        break;
      }

      case 'customer_wise': {
        let query = supabase
          .from('customers')
          .select(`*, loans(id, loan_code, principal_amount, remaining_balance, status), savings_accounts(id, account_code, balance), fixed_deposits(id, fd_code, principal_amount, status)`);
        
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);

        if (customer_id) query.eq('id', customer_id);

        const { data } = await query;
        reportData = { customers: data };
        break;
      }

      case 'due_payment': {
        let query = supabase
          .from('v_overdue_loans')
          .select('*')
          .order('days_overdue', { ascending: false });
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;

        const totalDue = (data || []).reduce((s: number, l: any) => s + l.remaining_balance, 0);
        reportData = { overdue_loans: data, total_outstanding: totalDue };
        break;
      }

      case 'income': {
        let query = supabase
          .from('loan_payments')
          .select('amount, interest_paid, payment_date, payment_method, loans!inner(branch_id)')
          .gte('payment_date', sDate)
          .lte('payment_date', eDate);
        if (req.user?.role !== 'owner') query = query.eq('loans.branch_id', req.user?.branch_id);
        const { data: payments } = await query;

        const totalIncome = (payments || []).reduce((s: number, p: any) => s + (p.interest_paid || 0), 0);
        reportData = {
          period: { start: sDate, end: eDate },
          payments: payments || [],
          total_interest_income: totalIncome
        };
        break;
      }

      default:
        res.status(400).json({ error: `Unknown report type: ${type}` });
        return;
    }

    // Save report snapshot
    await supabase.from('reports').insert({
      report_type: type,
      report_name: `${type.replace(/_/g, ' ').toUpperCase()} - ${format(today, 'dd MMM yyyy')}`,
      period_start: sDate,
      period_end: eDate,
      parameters: { customer_id },
      data: reportData as Record<string, unknown>,
      generated_by: req.user!.id,
      branch_id: req.user!.branch_id
    });

    res.json({ data: reportData, type, generated_at: today.toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// GET /api/reports/:type/export/:format
router.get('/:type/export/:format', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type, format: fileFormat } = req.params;
  const { start_date, end_date } = req.query;
  const sDate = (start_date as string) || format(startOfMonth(new Date()), 'yyyy-MM-dd');
  const eDate = (end_date as string) || format(endOfMonth(new Date()), 'yyyy-MM-dd');
  const endOfDayDate = `${eDate} 23:59:59`;

  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authorization token required' });
      return;
    }

    if (req.user?.role === 'staff' && !['daily_collection', 'customer_wise'].includes(type)) {
      res.status(403).json({ error: 'Staff are only permitted to export daily collections and customer-wise reports' });
      return;
    }

    if (fileFormat === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Report');

      if (type === 'daily_collection') {
        let query = supabase.from('loan_payments').select(`payment_code, payment_date, amount, payment_type, payment_method, customers(full_name, nic_number), loans!inner(branch_id)`).gte('payment_date', sDate).lte('payment_date', endOfDayDate);
        if (req.user?.role !== 'owner') query = query.eq('loans.branch_id', req.user?.branch_id);
        const { data } = await query;
        worksheet.columns = [
          { header: 'Receipt', key: 'payment_code', width: 20 },
          { header: 'Date', key: 'payment_date', width: 15 },
          { header: 'Customer', key: 'customer', width: 30 },
          { header: 'NIC', key: 'nic', width: 15 },
          { header: 'Type', key: 'payment_type', width: 15 },
          { header: 'Method', key: 'payment_method', width: 15 },
          { header: 'Amount (LKR)', key: 'amount', width: 15 },
        ];
        (data || []).forEach(p => worksheet.addRow({ ...p, customer: (p as any).customers?.full_name, nic: (p as any).customers?.nic_number || 'N/A' }));
      } else if (type === 'loan_summary') {
        let query = supabase.from('loans').select(`loan_code, status, principal_amount, remaining_balance, customers(full_name)`);
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        worksheet.columns = [
          { header: 'Loan Code', key: 'loan_code', width: 20 },
          { header: 'Customer', key: 'customer', width: 30 },
          { header: 'Status', key: 'status', width: 15 },
          { header: 'Principal', key: 'principal_amount', width: 15 },
          { header: 'Remaining Balance', key: 'remaining_balance', width: 15 },
        ];
        (data || []).forEach(l => worksheet.addRow({ ...l, 'Customer': (l as any).customers?.full_name || 'N/A' }));
      } else if (type === 'savings_summary') {
        let query = supabase.from('savings_accounts').select(`account_code, is_active, balance, total_deposited, customers(full_name)`);
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        worksheet.columns = [
          { header: 'Account', key: 'account_code', width: 20 },
          { header: 'Customer', key: 'customer', width: 30 },
          { header: 'Active', key: 'is_active', width: 10 },
          { header: 'Balance', key: 'balance', width: 15 },
          { header: 'Total Deposited', key: 'total_deposited', width: 15 },
        ];
        (data || []).forEach(a => worksheet.addRow({ ...a, 'Customer': (a as any).customers?.full_name || 'N/A' }));
      } else if (type === 'due_payment') {
        let query = supabase.from('v_overdue_loans').select('*');
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        worksheet.columns = [
          { header: 'Loan Code', key: 'loan_code', width: 20 },
          { header: 'Customer', key: 'customer_name', width: 30 },
          { header: 'Days Overdue', key: 'days_overdue', width: 15 },
          { header: 'Remaining Balance', key: 'remaining_balance', width: 20 },
        ];
        (data || []).forEach(l => worksheet.addRow(l));
      } else {
         worksheet.addRow(['Export data available in JSON format, basic Excel provided']);
      }

      worksheet.addRow([]);
      worksheet.addRow(['Generated on:', new Date().toLocaleString()]);
      worksheet.addRow(['Downloaded on:', new Date().toLocaleString()]);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${type}-${sDate}-to-${eDate}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } else if (fileFormat === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=${type}-${sDate}-to-${eDate}.pdf`);
      const doc = new PDFDocument({ margin: 30, layout: 'landscape' });
      doc.pipe(res);
      
      const settings = await getCompanySettings();
      const title = `Report: ${type.toUpperCase().replace(/_/g, ' ')}`;
      const subtitle = `Period: ${sDate} to ${eDate}`;
      addStandardHeader(doc, title, settings, subtitle);

      let columns: PDFTableColumn[] = [];
      let rows: any[] = [];

      if (type === 'daily_collection') {
        let query = supabase.from('loan_payments').select(`payment_code, payment_date, amount, payment_type, payment_method, customers(full_name, nic_number), loans!inner(loan_code, branch_id)`).gte('payment_date', sDate).lte('payment_date', endOfDayDate);
        if (req.user?.role !== 'owner') query = query.eq('loans.branch_id', req.user?.branch_id);
        const { data } = await query;
        columns = [
          { header: 'Receipt', key: 'payment_code', width: 100 },
          { header: 'Date', key: 'payment_date', width: 80 },
          { header: 'Customer', key: 'customer', width: 120 },
          { header: 'NIC', key: 'nic', width: 90 },
          { header: 'Loan', key: 'loan_code', width: 100 },
          { header: 'Type', key: 'payment_type', width: 70 },
          { header: 'Amount', key: 'amount', width: 100, align: 'right' },
        ];
        rows = (data || []).map(p => ({
          ...p,
          customer: (p as any).customers?.full_name,
          nic: (p as any).customers?.nic_number || 'N/A',
          loan_code: (p as any).loans?.loan_code,
          amount: Number(p.amount).toFixed(2)
        }));
      } else if (type === 'loan_summary') {
        let query = supabase.from('loans').select(`loan_code, status, principal_amount, remaining_balance, customers(full_name)`);
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        columns = [
          { header: 'Loan Code', key: 'loan_code', width: 120 },
          { header: 'Customer', key: 'customer', width: 200 },
          { header: 'Status', key: 'status', width: 100 },
          { header: 'Principal', key: 'principal', width: 120, align: 'right' },
          { header: 'Balance', key: 'balance', width: 120, align: 'right' },
        ];
        rows = (data || []).map(l => ({
          ...l,
          customer: (l as any).customers?.full_name || 'N/A',
          principal: Number(l.principal_amount).toFixed(2),
          balance: Number(l.remaining_balance).toFixed(2)
        }));
      } else if (type === 'savings_summary') {
        let query = supabase.from('savings_accounts').select(`account_code, is_active, balance, total_deposited, customers(full_name)`);
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        columns = [
          { header: 'Account', key: 'account_code', width: 120 },
          { header: 'Customer', key: 'customer', width: 200 },
          { header: 'Active', key: 'is_active', width: 80 },
          { header: 'Balance', key: 'balance', width: 120, align: 'right' },
          { header: 'Deposited', key: 'total_deposited', width: 120, align: 'right' },
        ];
        rows = (data || []).map(a => ({
          ...a,
          customer: (a as any).customers?.full_name || 'N/A',
          balance: Number(a.balance).toFixed(2),
          total_deposited: Number(a.total_deposited).toFixed(2)
        }));
      } else if (type === 'due_payment') {
        let query = supabase.from('v_overdue_loans').select('*');
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        columns = [
          { header: 'Loan Code', key: 'loan_code', width: 120 },
          { header: 'Customer', key: 'customer_name', width: 200 },
          { header: 'Overdue (Days)', key: 'days_overdue', width: 120 },
          { header: 'Balance (LKR)', key: 'balance', width: 150, align: 'right' },
        ];
        rows = (data || []).map(l => ({
          ...l,
          balance: Number(l.remaining_balance).toFixed(2)
        }));
      } else if (type === 'customer_wise') {
        let query = supabase.from('customers').select(`*, loans(id, loan_code, principal_amount, remaining_balance, status), savings_accounts(id, account_code, balance), fixed_deposits(id, fd_code, principal_amount, status)`);
        if (req.user?.role !== 'owner') query = query.eq('branch_id', req.user?.branch_id);
        const { data } = await query;
        columns = [
          { header: 'Customer', key: 'customer', width: 120 },
          { header: 'NIC', key: 'nic', width: 100 },
          { header: 'Loans', key: 'loans', width: 100 },
          { header: 'Savings', key: 'savings', width: 100 },
          { header: 'Fixed Deposits', key: 'fds', width: 100 },
        ];
        rows = (data || []).map(c => ({
          ...c,
          customer: c.full_name,
          nic: c.nic_number,
          loans: (c as any).loans?.length || 0,
          savings: (c as any).savings_accounts?.length || 0,
          fds: (c as any).fixed_deposits?.length || 0,
        }));
      }

      if (columns.length > 0 && rows.length > 0) {
        drawTable(doc, columns, rows, settings, title, subtitle);
      } else {
        doc.fontSize(10).text('No data available for the selected period.', { align: 'center' });
      }

      doc.moveDown(2);
      doc.text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
      
      doc.end();
    } else {
      res.status(400).json({ error: 'Unsupported format' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to export report' });
  }
});

// POST /api/reports/:type/email
router.post('/:type/email', async (req: AuthRequest, res: Response): Promise<void> => {
  const { type } = req.params;
  const { email } = req.body;
  try {
    const success = await sendEmail(email, `GVC Finance Report: ${type}`, `<p>Your requested report <b>${type}</b> has been generated.</p>`);
    if (success) {
      res.json({ message: 'Email sent successfully' });
    } else {
      res.status(500).json({ error: 'Failed to send email' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email' });
  }
});

export default router;
