"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySavingsTransaction = applySavingsTransaction;
exports.reverseSavingsTransaction = reverseSavingsTransaction;
const supabase_1 = require("../config/supabase");
async function applySavingsTransaction(txId) {
    const { data: tx, error: txErr } = await supabase_1.supabase
        .from('savings_transactions')
        .select('*, savings_accounts(*)')
        .eq('id', txId)
        .single();
    if (txErr || !tx)
        return { success: false, error: 'Transaction not found' };
    const account = tx.savings_accounts;
    if (!account?.is_active)
        return { success: false, error: 'Account inactive' };
    let newBalance = Number(account.balance);
    if (tx.transaction_type === 'deposit' || tx.transaction_type === 'interest') {
        newBalance += Number(tx.amount);
    }
    else if (tx.transaction_type === 'withdrawal') {
        if (Number(tx.amount) > newBalance - Number(account.minimum_balance)) {
            return { success: false, error: 'Insufficient balance' };
        }
        newBalance -= Number(tx.amount);
    }
    await supabase_1.supabase.from('savings_transactions').update({
        balance_after: newBalance,
        approval_status: 'approved'
    }).eq('id', txId);
    const updateData = { balance: newBalance };
    if (tx.transaction_type === 'deposit') {
        updateData.total_deposited = (account.total_deposited || 0) + Number(tx.amount);
    }
    if (tx.transaction_type === 'withdrawal') {
        updateData.total_withdrawn = (account.total_withdrawn || 0) + Number(tx.amount);
    }
    if (tx.transaction_type === 'interest') {
        updateData.total_interest_earned = (account.total_interest_earned || 0) + Number(tx.amount);
    }
    await supabase_1.supabase.from('savings_accounts').update(updateData).eq('id', tx.account_id);
    return { success: true };
}
async function reverseSavingsTransaction(txId) {
    const { data: tx } = await supabase_1.supabase
        .from('savings_transactions')
        .select('*, savings_accounts(*)')
        .eq('id', txId)
        .single();
    if (!tx)
        return { success: false, error: 'Transaction not found' };
    if (tx.approval_status !== 'approved') {
        await supabase_1.supabase.from('savings_transactions').update({
            approval_status: 'rejected',
            rejection_reason: 'Voided before approval'
        }).eq('id', txId);
        return { success: true };
    }
    const account = tx.savings_accounts;
    let newBalance = Number(account.balance);
    if (tx.transaction_type === 'deposit' || tx.transaction_type === 'interest') {
        newBalance -= Number(tx.amount);
    }
    else if (tx.transaction_type === 'withdrawal') {
        newBalance += Number(tx.amount);
    }
    await supabase_1.supabase.from('savings_accounts').update({
        balance: newBalance,
        total_deposited: tx.transaction_type === 'deposit'
            ? Math.max(0, (account.total_deposited || 0) - Number(tx.amount))
            : account.total_deposited,
        total_withdrawn: tx.transaction_type === 'withdrawal'
            ? Math.max(0, (account.total_withdrawn || 0) - Number(tx.amount))
            : account.total_withdrawn
    }).eq('id', tx.account_id);
    await supabase_1.supabase.from('savings_transactions').update({
        approval_status: 'rejected',
        rejection_reason: 'Voided per owner-approved correction'
    }).eq('id', txId);
    return { success: true };
}
//# sourceMappingURL=applySavings.js.map