"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyLoanPayment = applyLoanPayment;
exports.reverseLoanPayment = reverseLoanPayment;
const supabase_1 = require("../config/supabase");
async function applyLoanPayment(paymentId, userId) {
    const { data: payment, error: payErr } = await supabase_1.supabase
        .from('loan_payments')
        .select('*')
        .eq('id', paymentId)
        .single();
    if (payErr || !payment)
        return { success: false, error: 'Payment not found' };
    if (payment.approval_status === 'approved' && Number(payment.principal_paid) > 0) {
        return { success: true };
    }
    const { data: loan, error: loanError } = await supabase_1.supabase
        .from('loans')
        .select('*')
        .eq('id', payment.loan_id)
        .single();
    if (loanError || !loan)
        return { success: false, error: 'Loan not found' };
    if (loan.approval_status !== 'approved')
        return { success: false, error: 'Loan not active' };
    if (loan.is_fully_paid)
        return { success: false, error: 'Loan already fully paid' };
    const bodyAmount = Number(payment.amount);
    if (bodyAmount > Number(loan.remaining_balance) + 1) {
        return { success: false, error: 'Amount exceeds remaining balance' };
    }
    const paymentDate = payment.payment_date;
    let remainingPayment = bodyAmount;
    let totalInterestPaid = 0;
    let totalPrincipalPaid = 0;
    const { data: installments, error: scheduleError } = await supabase_1.supabase
        .from('loan_schedule')
        .select('*')
        .eq('loan_id', payment.loan_id)
        .in('status', ['pending', 'partial', 'overdue'])
        .order('installment_number', { ascending: true });
    if (scheduleError) {
        return { success: false, error: 'Failed to load loan schedule' };
    }
    const updatedInstallments = [];
    for (const installment of installments || []) {
        if (remainingPayment <= 0)
            break;
        const installmentAmount = Number(installment.installment_amount);
        const paidAmount = Number(installment.paid_amount || 0);
        const remainingInstallment = Math.max(0, installmentAmount - paidAmount);
        if (remainingInstallment <= 0)
            continue;
        const allocation = Math.min(remainingPayment, remainingInstallment);
        const proportion = installmentAmount > 0 ? allocation / installmentAmount : 0;
        const interestShare = Math.round((Number(installment.interest_amount) * proportion) * 100) / 100;
        const principalShare = Math.round((allocation - interestShare) * 100) / 100;
        totalInterestPaid += interestShare;
        totalPrincipalPaid += principalShare;
        remainingPayment -= allocation;
        const newPaidAmount = Math.min(installmentAmount, paidAmount + allocation);
        const newStatus = newPaidAmount >= installmentAmount ? 'paid' : 'partial';
        updatedInstallments.push({
            id: installment.id,
            paid_amount: newPaidAmount,
            status: newStatus
        });
    }
    if (remainingPayment > 0) {
        // Apply any remaining payment toward the loan balance even if schedule is fully paid.
        totalPrincipalPaid += remainingPayment;
        remainingPayment = 0;
    }
    const newBalance = Math.max(0, Number(loan.remaining_balance) - bodyAmount);
    const newAmountPaid = Number(loan.amount_paid) + bodyAmount;
    const isFullyPaid = newBalance <= 0.01 || payment.payment_type === 'full_settlement';
    let nextDueDate = null;
    if (!isFullyPaid) {
        const { data: nextInstallment } = await supabase_1.supabase
            .from('loan_schedule')
            .select('due_date')
            .eq('loan_id', payment.loan_id)
            .in('status', ['pending', 'partial', 'overdue'])
            .order('installment_number', { ascending: true })
            .limit(1)
            .single();
        nextDueDate = nextInstallment?.due_date || null;
    }
    if (updatedInstallments.length > 0) {
        for (const installment of updatedInstallments) {
            await supabase_1.supabase.from('loan_schedule').update({
                paid_amount: installment.paid_amount,
                status: installment.status,
                paid_date: paymentDate
            }).eq('id', installment.id);
        }
    }
    await supabase_1.supabase.from('loan_payments').update({
        principal_paid: totalPrincipalPaid,
        interest_paid: totalInterestPaid,
        approval_status: 'approved'
    }).eq('id', paymentId);
    await supabase_1.supabase.from('loans').update({
        amount_paid: newAmountPaid,
        remaining_balance: newBalance,
        last_payment_date: paymentDate,
        next_due_date: nextDueDate,
        is_fully_paid: isFullyPaid,
        status: isFullyPaid ? 'closed' : loan.status,
        updated_by: userId
    }).eq('id', payment.loan_id);
    return { success: true };
}
async function reverseLoanPayment(paymentId, userId) {
    const { data: payment } = await supabase_1.supabase.from('loan_payments').select('*').eq('id', paymentId).single();
    if (!payment)
        return { success: false, error: 'Payment not found' };
    if (payment.approval_status !== 'approved') {
        await supabase_1.supabase.from('loan_payments').update({
            approval_status: 'rejected',
            rejection_reason: 'Voided before approval'
        }).eq('id', paymentId);
        return { success: true };
    }
    const { data: loan } = await supabase_1.supabase.from('loans').select('*').eq('id', payment.loan_id).single();
    if (!loan)
        return { success: false, error: 'Loan not found' };
    const amount = Number(payment.amount);
    await supabase_1.supabase.from('loans').update({
        amount_paid: Math.max(0, Number(loan.amount_paid) - amount),
        remaining_balance: Number(loan.remaining_balance) + amount,
        is_fully_paid: false,
        status: loan.status === 'closed' ? 'active' : loan.status,
        updated_by: userId
    }).eq('id', payment.loan_id);
    await supabase_1.supabase.from('loan_payments').update({
        approval_status: 'rejected',
        rejection_reason: 'Voided per owner-approved correction'
    }).eq('id', paymentId);
    return { success: true };
}
//# sourceMappingURL=applyPayment.js.map