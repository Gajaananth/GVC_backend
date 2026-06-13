import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { sendSMS } from '../utils/sms';
import { sendEmail } from '../utils/email';
import { format } from 'date-fns';

const router = Router();

// A simple API key middleware for cron tasks
const cronKey = process.env.CRON_SECRET;
if (!cronKey) {
  throw new Error('Missing required environment variable: CRON_SECRET');
}

const requireCronKey = (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${cronKey}`) {
    res.status(401).json({ error: 'Unauthorized cron access' });
    return;
  }
  next();
};

router.use(requireCronKey);

router.post('/nightly', async (_req: Request, res: Response): Promise<void> => {
  logger.info('Starting nightly cron job...');
  const todayDate = format(new Date(), 'yyyy-MM-dd');

  try {
    // 1. Mark overdue installments
    const { data: overdueSchedules, error: schError } = await supabase
      .from('loan_schedule')
      .update({ status: 'overdue' })
      .lt('due_date', todayDate)
      .in('status', ['pending', 'partial'])
      .select('id, loan_id');

    if (schError) throw schError;
    logger.info(`Marked ${overdueSchedules?.length || 0} installments as overdue.`);

    // 2. Mark loans as overdue if they have overdue installments
    const loanIds = [...new Set(overdueSchedules?.map(s => s.loan_id) || [])];
    if (loanIds.length > 0) {
      await supabase
        .from('loans')
        .update({ status: 'overdue' })
        .in('id', loanIds)
        .eq('status', 'active');
      logger.info(`Marked ${loanIds.length} loans as overdue.`);
    }

    // 3. Apply late fees on overdue installments that have passed the grace period
    const { data: settingsData, error: settingsError } = await supabase
      .from('company_settings')
      .select('late_fee_percentage, grace_period_days')
      .limit(1);
    if (settingsError) throw settingsError;

    const settings = Array.isArray(settingsData) ? settingsData[0] : settingsData;
    const lateFeePct = Number(settings?.late_fee_percentage || 2.0);
    const graceDays = Number(settings?.grace_period_days || 3);
    
    // Find installments that are overdue and passed the grace period
    const graceDate = new Date();
    graceDate.setDate(graceDate.getDate() - graceDays);
    const graceDateStr = format(graceDate, 'yyyy-MM-dd');

    const { data: pastGraceSchedules } = await supabase
      .from('loan_schedule')
      .select('loan_id')
      .eq('status', 'overdue')
      .lt('due_date', graceDateStr);
      
    const pastGraceLoanIds = [...new Set(pastGraceSchedules?.map(s => s.loan_id) || [])];

    if (pastGraceLoanIds.length > 0) {
      const { data: loans } = await supabase
        .from('loans')
        .select('id, remaining_balance, late_fees')
        .in('id', pastGraceLoanIds);

      if (loans) {
        for (const loan of loans) {
          const fee = Math.round((Number(loan.remaining_balance) * lateFeePct) / 100 * 100) / 100;
          if (fee > 0) {
            await supabase
              .from('loans')
              .update({ 
                late_fees: Number(loan.late_fees || 0) + fee,
                remaining_balance: Number(loan.remaining_balance) + fee
              })
              .eq('id', loan.id);
          }
        }
        logger.info(`Applied late fees to ${loans.length} loans.`);
      }
    }

    // 4. Send due date reminders for next 3 days
    const nextThreeDays = new Date();
    nextThreeDays.setDate(nextThreeDays.getDate() + 3);
    const targetDate = format(nextThreeDays, 'yyyy-MM-dd');

    const { data: upcomingSchedules } = await supabase
      .from('loan_schedule')
      .select('*, loans(loan_code, customers(phone, full_name))')
      .eq('due_date', targetDate)
      .eq('status', 'pending');

    if (upcomingSchedules && upcomingSchedules.length > 0) {
      for (const schedule of upcomingSchedules) {
        if (schedule.loans?.customers?.phone) {
          const amountDue = Number(schedule.installment_amount) - Number(schedule.paid_amount || 0);
          const message = `Dear ${schedule.loans.customers.full_name}, reminder: LKR ${amountDue} is due for your loan ${schedule.loans.loan_code} on ${targetDate}. GVC Agro Finance.`;
          await sendSMS(schedule.loans.customers.phone, message);
        }
      }
      logger.info(`Sent ${upcomingSchedules.length} due reminders.`);
    }

    // 5. Add savings interest accrual
    const { data: savingsAccounts } = await supabase
      .from('savings_accounts')
      .select('id, customer_id, balance, interest_rate, interest_frequency')
      .eq('is_active', true)
      .gt('interest_rate', 0);

    let interestCreditedCount = 0;
    if (savingsAccounts && savingsAccounts.length > 0) {
      for (const acc of savingsAccounts) {
        const rate = Number(acc.interest_rate);
        const bal = Number(acc.balance);
        let interest = 0;

        // Simplified daily calculation for the cron (if rate is annual)
        if (acc.interest_frequency === 'daily') {
          interest = Math.round(((bal * rate) / 365 / 100) * 100) / 100;
        } else if (acc.interest_frequency === 'monthly') {
          // If monthly, only apply on the 1st of the month
          if (new Date().getDate() === 1) {
             interest = Math.round(((bal * rate) / 12 / 100) * 100) / 100;
          }
        } else if (acc.interest_frequency === 'annually') {
          // If annually, only apply on Jan 1
          if (new Date().getMonth() === 0 && new Date().getDate() === 1) {
             interest = Math.round(((bal * rate) / 100) * 100) / 100;
          }
        }

        if (interest > 0) {
          const newBal = bal + interest;
          await supabase.from('savings_transactions').insert({
            account_id: acc.id,
            customer_id: acc.customer_id,
            transaction_type: 'interest',
            amount: interest,
            balance_after: newBal,
            transaction_date: todayDate,
            description: 'Automated interest credit',
            approval_status: 'approved'
          });
          await supabase.from('savings_accounts').update({
            balance: newBal,
            total_interest_earned: interest
          }).eq('id', acc.id);
          interestCreditedCount++;
        }
      }
      if (interestCreditedCount > 0) {
         logger.info(`Credited interest to ${interestCreditedCount} savings accounts.`);
      }
    }

    // Log cron execution
    await supabase.from('activity_logs').insert({
      user_id: '00000000-0000-0000-0000-000000000000', // System user ID
      user_name: 'SYSTEM',
      user_role: 'system',
      action: 'CRON_EXECUTION',
      entity_type: 'system',
      description: 'Nightly cron job completed',
      ip_address: '127.0.0.1'
    });

    // 6. Generate Daily System Report and Email
    const { count: activeLoansCount } = await supabase.from('loans').select('id', { count: 'exact', head: true }).eq('status', 'active');
    const { count: overdueLoansCount } = await supabase.from('loans').select('id', { count: 'exact', head: true }).eq('status', 'overdue');
    const { count: pendingApprovalsCount } = await supabase.from('loans').select('id', { count: 'exact', head: true }).eq('approval_status', 'pending_approval');
    
    // Total collections today
    const { data: todayCollections } = await supabase.from('loan_payments').select('amount').eq('payment_date', todayDate).eq('approval_status', 'approved');
    const totalCollected = (todayCollections || []).reduce((sum, p) => sum + p.amount, 0);

    const emailHtml = `
      <h2>GVC Agro Finance - Daily System Report</h2>
      <p><b>Date:</b> ${todayDate}</p>
      <p><b>Total Collected Today:</b> LKR ${totalCollected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
      <ul>
        <li>Active Loans: ${activeLoansCount || 0}</li>
        <li>Overdue Loans: ${overdueLoansCount || 0}</li>
        <li>Pending Loan Approvals: ${pendingApprovalsCount || 0}</li>
        <li>Savings Interest Accounts Credited: ${interestCreditedCount}</li>
      </ul>
      <p>Automated cron job execution completed successfully.</p>
    `;

    await sendEmail(
      'gajaananthnadan17898@gmail.com', 
      `Daily Finance Report - ${todayDate}`, 
      emailHtml
    );

    res.json({ message: 'Nightly cron job completed successfully' });
  } catch (error: any) {
    logger.error('Nightly cron job failed', error);
    res.status(500).json({ error: error.message || 'Cron job failed' });
  }
});

export default router;
