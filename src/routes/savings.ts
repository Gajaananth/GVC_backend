import { Router, Response } from 'express';
import { z } from 'zod';
import { format } from 'date-fns';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireWrite, AuthRequest } from '../middleware/auth';
import { calculateSavingsInterest } from '../utils/calculations';

const router = Router();
router.use(authenticateJWT);

const createSavingsSchema = z.object({
  customer_id: z.string().uuid(),
  account_type: z.enum(['regular', 'fixed', 'recurring']).default('regular'),
  interest_rate: z.number().min(0).default(0),
  interest_frequency: z.enum(['daily', 'monthly', 'yearly']).default('monthly'),
  minimum_balance: z.number().min(0).default(0),
  notes: z.string().optional().nullable()
});

const transactionSchema = z.object({
  transaction_type: z.enum(['deposit', 'withdrawal', 'interest']),
  amount: z.number().positive(),
  transaction_date: z.string().optional(),
  payment_method: z.enum(['cash', 'bank_transfer', 'cheque', 'mobile']).default('cash'),
  reference_number: z.string().optional().nullable(),
  description: z.string().optional().nullable()
});

// GET /api/savings
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const { search, customer_id, account_type, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('savings_accounts')
    .select(`*, customers(id, customer_code, full_name, phone)`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (customer_id) query = query.eq('customer_id', customer_id);
  if (account_type) query = query.eq('account_type', account_type);
  if (search) query = query.or(`account_code.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});

// GET /api/savings/:id
router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: account, error } = await supabase
    .from('savings_accounts')
    .select(`*, customers(id, customer_code, full_name, phone, address, email)`)
    .eq('id', req.params.id)
    .single();

  if (error || !account) { res.status(404).json({ error: 'Savings account not found' }); return; }

  const { data: transactions } = await supabase
    .from('savings_transactions')
    .select('*')
    .eq('account_id', req.params.id)
    .order('transaction_date', { ascending: false });

  res.json({ data: { ...account, transactions: transactions || [] } });
});

// POST /api/savings - create account
router.post('/', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = createSavingsSchema.parse(req.body);

    const { data: customer } = await supabase
      .from('customers')
      .select('id, full_name, is_active')
      .eq('id', body.customer_id)
      .single();

    if (!customer || !customer.is_active) {
      res.status(404).json({ error: 'Customer not found or inactive' });
      return;
    }

    const { data, error } = await supabase
      .from('savings_accounts')
      .insert({ ...body, created_by: req.user!.id })
      .select()
      .single();

    if (error) { res.status(500).json({ error: error.message }); return; }

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'savings',
      entity_id: data.id, entity_code: data.account_code,
      description: `Created savings account ${data.account_code} for ${customer.full_name}`
    });

    res.status(201).json({ data, message: 'Savings account created successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to create savings account' });
  }
});

// POST /api/savings/:id/transactions - deposit or withdraw
router.post('/:id/transactions', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = transactionSchema.parse(req.body);
    const txDate = body.transaction_date || format(new Date(), 'yyyy-MM-dd');

    const { data: account, error: accErr } = await supabase
      .from('savings_accounts')
      .select('*, customers(id, full_name)')
      .eq('id', req.params.id)
      .single();

    if (accErr || !account) { res.status(404).json({ error: 'Savings account not found' }); return; }
    if (!account.is_active) { res.status(400).json({ error: 'Savings account is inactive' }); return; }

    let newBalance = account.balance;
    if (body.transaction_type === 'deposit' || body.transaction_type === 'interest') {
      newBalance += body.amount;
    } else if (body.transaction_type === 'withdrawal') {
      if (body.amount > account.balance - account.minimum_balance) {
        res.status(400).json({ error: `Insufficient balance. Available: ₨${(account.balance - account.minimum_balance).toLocaleString()}` });
        return;
      }
      newBalance -= body.amount;
    }

    const { data: tx, error: txErr } = await supabase
      .from('savings_transactions')
      .insert({
        account_id: req.params.id,
        customer_id: account.customer_id,
        transaction_type: body.transaction_type,
        amount: body.amount,
        balance_after: newBalance,
        transaction_date: txDate,
        payment_method: body.payment_method,
        reference_number: body.reference_number,
        description: body.description,
        created_by: req.user!.id
      })
      .select()
      .single();

    if (txErr || !tx) { res.status(500).json({ error: txErr?.message }); return; }

    // Update account balance and totals
    const updateData: Record<string, unknown> = { balance: newBalance };
    if (body.transaction_type === 'deposit') updateData.total_deposited = (account.total_deposited || 0) + body.amount;
    if (body.transaction_type === 'withdrawal') updateData.total_withdrawn = (account.total_withdrawn || 0) + body.amount;
    if (body.transaction_type === 'interest') updateData.total_interest_earned = (account.total_interest_earned || 0) + body.amount;

    await supabase.from('savings_accounts').update(updateData).eq('id', req.params.id);

    await supabase.from('activity_logs').insert({
      user_id: req.user!.id, user_name: req.user!.full_name, user_role: req.user!.role,
      action: 'CREATE', entity_type: 'savings_transaction',
      entity_id: tx.id, entity_code: tx.transaction_code,
      description: `${body.transaction_type === 'deposit' ? 'Deposited' : 'Withdrew'} ₨${body.amount.toLocaleString()} to/from ${account.account_code}`
    });

    res.status(201).json({ data: { ...tx, new_balance: newBalance }, message: `${body.transaction_type} successful` });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return; }
    res.status(500).json({ error: 'Failed to process transaction' });
  }
});

// POST /api/savings/:id/apply-interest - apply monthly interest
router.post('/:id/apply-interest', requireWrite, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data: account } = await supabase
    .from('savings_accounts')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!account) { res.status(404).json({ error: 'Savings account not found' }); return; }

  const interest = calculateSavingsInterest(account.balance, account.interest_rate, account.interest_frequency);

  if (interest <= 0) { res.json({ message: 'No interest to apply', interest: 0 }); return; }

  // Reuse deposit flow
  req.body = {
    transaction_type: 'interest',
    amount: interest,
    description: `${account.interest_frequency} interest credit at ${account.interest_rate}% p.a.`
  };

  // Delegate to transaction handler (simplified re-call)
  const newBalance = account.balance + interest;

  await supabase.from('savings_transactions').insert({
    account_id: req.params.id,
    customer_id: account.customer_id,
    transaction_type: 'interest',
    amount: interest,
    balance_after: newBalance,
    transaction_date: format(new Date(), 'yyyy-MM-dd'),
    description: `${account.interest_frequency} interest at ${account.interest_rate}% p.a.`,
    created_by: req.user!.id
  });

  await supabase.from('savings_accounts').update({
    balance: newBalance,
    total_interest_earned: (account.total_interest_earned || 0) + interest
  }).eq('id', req.params.id);

  res.json({ message: 'Interest applied successfully', interest, new_balance: newBalance });
});

export default router;
