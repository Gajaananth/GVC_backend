import { format } from 'date-fns';
import { supabase } from '../config/supabase';

export async function applyLoanPayment(paymentId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const { data: payment, error: payErr } = await supabase
    .from('loan_payments')
    .select('*')
    .eq('id', paymentId)
    .single();

  if (payErr || !payment) return { success: false, error: 'Payment not found' };
  if (payment.approval_status === 'approved' && Number(payment.principal_paid) > 0) {
    return { success: true };
  }

  const { data: loan, error: loanError } = await supabase
    .from('loans')
    .select('*')
    .eq('id', payment.loan_id)
    .single();

  if (loanError || !loan) return { success: false, error: 'Loan not found' };
  if (loan.approval_status !== 'approved') return { success: false, error: 'Loan not active' };
  if (loan.is_fully_paid) return { success: false, error: 'Loan already fully paid' };

  const bodyAmount = Number(payment.amount);
  if (bodyAmount > Number(loan.remaining_balance) + 1) {
    return { success: false, error: 'Amount exceeds remaining balance' };
  }

  const interestPerInstallment = Number(loan.total_interest) / loan.duration_months;
  const interestPaid = Math.min(interestPerInstallment, bodyAmount);
  const principalPaid = Math.max(0, bodyAmount - interestPaid);
  const paymentDate = payment.payment_date;

  const newBalance = Math.max(0, Number(loan.remaining_balance) - bodyAmount);
  const newAmountPaid = Number(loan.amount_paid) + bodyAmount;
  const isFullyPaid = newBalance <= 0.01 || payment.payment_type === 'full_settlement';

  const { data: pendingInstallments } = await supabase
    .from('loan_schedule')
    .select('*')
    .eq('loan_id', payment.loan_id)
    .in('status', ['pending', 'partial', 'overdue'])
    .order('installment_number', { ascending: true })
    .limit(1);

  const currentInstallment = pendingInstallments?.[0];
  let nextDueDate: string | null = null;

  if (!isFullyPaid && currentInstallment) {
    const { data: nextInstallment } = await supabase
      .from('loan_schedule')
      .select('due_date')
      .eq('loan_id', payment.loan_id)
      .in('status', ['pending', 'partial'])
      .gt('installment_number', currentInstallment.installment_number)
      .order('installment_number', { ascending: true })
      .limit(1)
      .single();
    nextDueDate = nextInstallment?.due_date || null;
  }

  await supabase.from('loan_payments').update({
    principal_paid: principalPaid,
    interest_paid: interestPaid,
    approval_status: 'approved'
  }).eq('id', paymentId);

  await supabase.from('loans').update({
    amount_paid: newAmountPaid,
    remaining_balance: newBalance,
    last_payment_date: paymentDate,
    next_due_date: nextDueDate,
    is_fully_paid: isFullyPaid,
    status: isFullyPaid ? 'closed' : loan.status === 'overdue' ? 'active' : loan.status,
    updated_by: userId
  }).eq('id', payment.loan_id);

  if (currentInstallment) {
    const newPaid = (currentInstallment.paid_amount || 0) + bodyAmount;
    const installmentStatus = newPaid >= currentInstallment.installment_amount ? 'paid' : 'partial';
    await supabase.from('loan_schedule').update({
      paid_amount: Math.min(newPaid, currentInstallment.installment_amount),
      status: installmentStatus,
      paid_date: paymentDate
    }).eq('id', currentInstallment.id);
  }

  return { success: true };
}

export async function reverseLoanPayment(paymentId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const { data: payment } = await supabase.from('loan_payments').select('*').eq('id', paymentId).single();
  if (!payment) return { success: false, error: 'Payment not found' };

  if (payment.approval_status !== 'approved') {
    await supabase.from('loan_payments').update({
      approval_status: 'rejected',
      rejection_reason: 'Voided before approval'
    }).eq('id', paymentId);
    return { success: true };
  }

  const { data: loan } = await supabase.from('loans').select('*').eq('id', payment.loan_id).single();
  if (!loan) return { success: false, error: 'Loan not found' };

  const amount = Number(payment.amount);
  await supabase.from('loans').update({
    amount_paid: Math.max(0, Number(loan.amount_paid) - amount),
    remaining_balance: Number(loan.remaining_balance) + amount,
    is_fully_paid: false,
    status: loan.status === 'closed' ? 'active' : loan.status,
    updated_by: userId
  }).eq('id', payment.loan_id);

  await supabase.from('loan_payments').update({
    approval_status: 'rejected',
    rejection_reason: 'Voided per owner-approved correction'
  }).eq('id', paymentId);

  return { success: true };
}
