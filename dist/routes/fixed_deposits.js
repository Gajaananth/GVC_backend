"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const pdfkit_1 = __importDefault(require("pdfkit"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const pdfTableGenerator_1 = require("../utils/pdfTableGenerator");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const createFDSchema = zod_1.z.object({
    customer_id: zod_1.z.string().uuid(),
    principal_amount: zod_1.z.number().positive(),
    interest_rate: zod_1.z.number().positive(),
    term_months: zod_1.z.number().int().positive(),
    payout_method: zod_1.z.enum(['cash', 'bank_transfer', 'cheque']).default('cash'),
    notes: zod_1.z.string().optional().nullable()
});
// GET /api/fixed-deposits
router.get('/', async (req, res) => {
    const { status, customer_id, branch_id, search, page = '1', limit = '10' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const offset = (pageNum - 1) * limitNum;
    let query = supabase_1.supabase
        .from('fixed_deposits')
        .select(`
      *,
      customers(id, full_name, customer_code, nic_number),
      branches(id, branch_name)
    `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1);
    if (status)
        query = query.eq('status', status);
    if (customer_id)
        query = query.eq('customer_id', customer_id);
    // Apply branch isolation
    if (req.user?.role !== 'owner') {
        query = query.eq('branch_id', req.user?.branch_id);
    }
    else if (branch_id) {
        query = query.eq('branch_id', branch_id);
    }
    if (search) {
        const safeSearch = search.replace(/"/g, '');
        query = query.ilike('fd_code', `%${safeSearch}%`);
    }
    const { data, error, count } = await query;
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({
        data,
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil((count || 0) / limitNum)
    });
});
// GET /api/fixed-deposits/:id
router.get('/:id', async (req, res) => {
    const { data, error } = await supabase_1.supabase
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
    if (error || !data) {
        res.status(404).json({ error: 'Fixed deposit not found' });
        return;
    }
    if (req.user?.role !== 'owner' && data.branch_id !== req.user?.branch_id) {
        res.status(403).json({ error: 'Access denied to this fixed deposit' });
        return;
    }
    res.json({ data });
});
// POST /api/fixed-deposits
router.post('/', async (req, res) => {
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
        const { data: customer } = await supabase_1.supabase
            .from('customers')
            .select('branch_id')
            .eq('id', body.customer_id)
            .single();
        if (!customer) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
        const branchId = customer.branch_id;
        const isOwner = req.user.role === 'owner';
        const status = isOwner ? 'active' : 'pending';
        const approvedBy = isOwner ? req.user.id : null;
        const approvedAt = isOwner ? new Date().toISOString() : null;
        const { data, error } = await supabase_1.supabase
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
            created_by: req.user.id,
            approved_by: approvedBy,
            approved_at: approvedAt
        })
            .select()
            .single();
        if (error) {
            res.status(500).json({ error: error.message });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to create fixed deposit' });
    }
});
// POST /api/fixed-deposits/:id/approve
router.post('/:id/approve', auth_1.requireAdmin, async (req, res) => {
    const { data: fd } = await supabase_1.supabase
        .from('fixed_deposits')
        .select('*, customers(full_name)')
        .eq('id', req.params.id)
        .single();
    if (!fd || fd.status !== 'pending') {
        res.status(404).json({ error: 'Pending fixed deposit not found' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('fixed_deposits')
        .update({
        status: 'active',
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'UPDATE',
        entity_type: 'fixed_deposit',
        entity_id: data.id,
        entity_code: data.fd_code,
        description: 'Approved fixed deposit ' + data.fd_code
    });
    res.json({ data, message: 'Fixed deposit approved successfully' });
});
// POST /api/fixed-deposits/:id/reject
router.post('/:id/reject', auth_1.requireAdmin, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('fixed_deposits')
        .update({
        status: 'rejected',
        approved_by: req.user.id,
        approved_at: new Date().toISOString()
    })
        .eq('id', req.params.id)
        .eq('status', 'pending')
        .select()
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Fixed deposit not found or not pending' });
        return;
    }
    res.json({ data, message: 'Fixed deposit rejected' });
});
// POST /api/fixed-deposits/:id/close
router.post('/:id/close', auth_1.requireAdmin, async (req, res) => {
    // Only matured or active FDs can be closed
    const { data: fd } = await supabase_1.supabase
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
    const { data, error } = await supabase_1.supabase
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
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'UPDATE',
        entity_type: 'fixed_deposit',
        entity_id: data.id,
        entity_code: data.fd_code,
        description: 'Closed fixed deposit ' + data.fd_code
    });
    res.json({ data, message: 'Fixed deposit closed successfully' });
});
// GET /api/fixed-deposits/:id/closure-certificate
router.get('/:id/closure-certificate', async (req, res) => {
    try {
        const { data: fd } = await supabase_1.supabase
            .from('fixed_deposits')
            .select('*, customers(full_name, nic_number, address)')
            .eq('id', req.params.id)
            .single();
        if (!fd) {
            res.status(404).json({ error: 'Fixed deposit not found' });
            return;
        }
        if (fd.status !== 'closed') {
            res.status(400).json({ error: 'Closure certificate can only be generated for closed fixed deposits' });
            return;
        }
        if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access denied to this closure certificate' });
            return;
        }
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        const doc = new pdfkit_1.default({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=FD-Closure-Certificate-${fd.fd_code}.pdf`);
        doc.pipe(res);
        (0, pdfTableGenerator_1.addStandardHeader)(doc, 'FIXED DEPOSIT CLOSURE CERTIFICATE', settings);
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
    }
    catch (err) {
        console.error('Closure PDF Generation Error:', err);
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to generate closure PDF' });
    }
});
// POST /api/fixed-deposits/:id/block
router.post('/:id/block', auth_1.requireAdmin, async (req, res) => {
    const { reason } = req.body;
    const { data: fd } = await supabase_1.supabase
        .from('fixed_deposits')
        .select('*')
        .eq('id', req.params.id)
        .single();
    if (!fd) {
        res.status(404).json({ error: 'Fixed deposit not found' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('fixed_deposits')
        .update({
        is_blocked: true,
        block_reason: reason || 'Blocked by admin'
    })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'UPDATE',
        entity_type: 'fixed_deposit',
        entity_id: data.id,
        entity_code: data.fd_code,
        description: `Blocked fixed deposit ${data.fd_code}. Reason: ${reason || 'Blocked by admin'}`
    });
    res.json({ data, message: 'Fixed deposit blocked successfully' });
});
// POST /api/fixed-deposits/:id/unblock
router.post('/:id/unblock', auth_1.requireAdmin, async (req, res) => {
    const { data: fd } = await supabase_1.supabase
        .from('fixed_deposits')
        .select('*')
        .eq('id', req.params.id)
        .eq('is_blocked', true)
        .single();
    if (!fd) {
        res.status(404).json({ error: 'Blocked fixed deposit not found' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('fixed_deposits')
        .update({
        is_blocked: false,
        block_reason: null
    })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id,
        user_name: req.user.full_name,
        user_role: req.user.role,
        action: 'UPDATE',
        entity_type: 'fixed_deposit',
        entity_id: data.id,
        entity_code: data.fd_code,
        description: `Unblocked fixed deposit ${data.fd_code}`
    });
    res.json({ data, message: 'Fixed deposit unblocked successfully' });
});
// GET /api/fixed-deposits/:id/certificate
router.get('/:id/certificate', async (req, res) => {
    try {
        const { data: fd } = await supabase_1.supabase
            .from('fixed_deposits')
            .select('*, customers(full_name, nic_number, address)')
            .eq('id', req.params.id)
            .single();
        if (!fd) {
            res.status(404).json({ error: 'Fixed deposit not found' });
            return;
        }
        // Authorization check: user must be owner, admin, or belong to the FD's branch
        if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access denied to this certificate' });
            return;
        }
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        const doc = new pdfkit_1.default({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=FD-Certificate-${fd.fd_code}.pdf`);
        doc.pipe(res);
        (0, pdfTableGenerator_1.addStandardHeader)(doc, 'FIXED DEPOSIT CERTIFICATE', settings);
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
    }
    catch (err) {
        console.error('PDF Generation Error:', err);
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to generate PDF' });
    }
});
// Helper for professional certificates
const addProfessionalCertificateFrame = (doc, title) => {
    const margin = 40;
    // Double Border
    doc.rect(margin, margin, doc.page.width - margin * 2, doc.page.height - margin * 2).lineWidth(2).stroke('#166534');
    doc.rect(margin + 5, margin + 5, doc.page.width - (margin + 5) * 2, doc.page.height - (margin + 5) * 2).lineWidth(1).stroke('#166534');
    doc.y = margin + 20;
    const logoPath = path_1.default.join(process.cwd(), 'logo.png');
    if (fs_1.default.existsSync(logoPath)) {
        doc.image(logoPath, (doc.page.width - 60) / 2, doc.y, { width: 60 });
        doc.y += 65;
    }
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#166534').text('GVC', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#333333');
    doc.text('SCHOOL ROAD, THANGAVELAYUTHAPURAM, AMPARA, THIRUKKOVIL,', { align: 'center' });
    doc.text('AMPARA, EASTERN PROVINCE, SRI LANKA, 32500', { align: 'center' });
    doc.text('Phone: +94 754 317 396', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text(title, { align: 'center', underline: true });
    doc.moveDown(1.5);
};
const drawSignatures = (doc, sigY) => {
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
    // Customer Signature
    doc.text('_____________________', 60, sigY);
    doc.text('Customer Signature', 60, sigY + 18);
    doc.text('Name: _________________', 60, sigY + 35);
    doc.text('Date: _________________', 60, sigY + 50);
    // Owner Signature
    doc.text('_____________________', doc.page.width - 240, sigY);
    doc.text('Owner / Authorized Signature', doc.page.width - 240, sigY + 18);
    doc.text('Name: _________________', doc.page.width - 240, sigY + 35);
    doc.text('Designation: ___________', doc.page.width - 240, sigY + 50);
    doc.text('Date: _________________', doc.page.width - 240, sigY + 65);
    // Seal area
    doc.rect(doc.page.width / 2 - 50, sigY, 100, 70).lineWidth(1).stroke('#cccccc');
    doc.fontSize(9).fillColor('#999999').text('Company Seal', doc.page.width / 2 - 45, sigY + 30, { align: 'center', width: 90 });
};
// GET /api/fixed-deposits/:id/creation-certificate
router.get('/:id/creation-certificate', async (req, res) => {
    try {
        const { data: fd } = await supabase_1.supabase
            .from('fixed_deposits')
            .select('*, customers(full_name, nic_number, address, phone_number)')
            .eq('id', req.params.id)
            .single();
        if (!fd) {
            res.status(404).json({ error: 'Fixed deposit not found' });
            return;
        }
        if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        const doc = new pdfkit_1.default({ margin: 40, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=FD-Certificate-${fd.fd_code}.pdf`);
        doc.pipe(res);
        addProfessionalCertificateFrame(doc, 'FIXED DEPOSIT CERTIFICATE');
        // Header Info (Right aligned)
        doc.fontSize(10).font('Helvetica-Bold').text(`Certificate No: CERT-${fd.fd_code}`, 60, doc.y, { align: 'right' });
        doc.font('Helvetica').text(`FD Number: ${fd.fd_code}`, { align: 'right' });
        doc.text(`Issue Date: ${new Date(fd.created_at).toLocaleDateString()}`, { align: 'right' });
        doc.moveDown(2);
        // Details Table (No Borders, just aligned)
        const drawRow = (label, value, y) => {
            doc.font('Helvetica-Bold').text(label, 60, y, { width: 180 });
            doc.font('Helvetica').text(value, 240, y);
        };
        let currY = doc.y;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Customer Information', 60, currY);
        currY += 20;
        doc.fontSize(10).fillColor('#000000');
        drawRow('Customer Name:', fd.customers.full_name, currY);
        currY += 15;
        drawRow('NIC Number:', fd.customers.nic_number, currY);
        currY += 15;
        drawRow('Address:', fd.customers.address || '-', currY);
        currY += 15;
        drawRow('Phone Number:', fd.customers.phone_number || '-', currY);
        currY += 25;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Fixed Deposit Information', 60, currY);
        currY += 20;
        doc.fontSize(10).fillColor('#000000');
        drawRow('Deposit Date:', new Date(fd.created_at).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Principal Amount:', `${settings.currency_symbol} ${Number(fd.principal_amount).toLocaleString()}`, currY);
        currY += 15;
        drawRow('Interest Rate:', `${fd.interest_rate}% p.a.`, currY);
        currY += 15;
        drawRow('Deposit Period:', `${fd.term_months} Months`, currY);
        currY += 15;
        drawRow('Maturity Date:', new Date(fd.maturity_date).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Expected Maturity Value:', `${settings.currency_symbol} ${Number(fd.total_maturity_amount).toLocaleString()}`, currY);
        currY += 30;
        doc.y = currY;
        // Declaration
        doc.fontSize(10).font('Helvetica-Oblique').fillColor('#333333');
        doc.text('This is to certify that the above-mentioned customer has invested the stated amount as a Fixed Deposit with GVC under the agreed terms and conditions. Upon successful completion of the deposit period, the customer shall be entitled to receive the maturity value specified in this certificate, subject to company policies and applicable regulations.', 60, doc.y, { align: 'justify', width: doc.page.width - 120 });
        // Signatures
        drawSignatures(doc, doc.page.height - 180);
        // Footer
        doc.fontSize(8).font('Helvetica').fillColor('#999999').text(`Generated By System | Date: ${new Date().toLocaleString()} | Ref: ${fd.id.substring(0, 8).toUpperCase()}`, 60, doc.page.height - 60, { align: 'center' });
        doc.end();
    }
    catch (err) {
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to generate certificate' });
    }
});
// GET /api/fixed-deposits/:id/early-closure-certificate
router.get('/:id/early-closure-certificate', async (req, res) => {
    try {
        const { data: fd } = await supabase_1.supabase
            .from('fixed_deposits')
            .select('*, customers(full_name, nic_number, address)')
            .eq('id', req.params.id)
            .eq('status', 'closed')
            .single();
        if (!fd) {
            res.status(404).json({ error: 'Closed fixed deposit not found' });
            return;
        }
        if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        const doc = new pdfkit_1.default({ margin: 40, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=FD-Early-Closure-${fd.fd_code}.pdf`);
        doc.pipe(res);
        addProfessionalCertificateFrame(doc, 'EARLY FIXED DEPOSIT CLOSURE CERTIFICATE');
        doc.fontSize(10).font('Helvetica-Bold').text(`Certificate No: CLOS-${fd.fd_code}`, 60, doc.y, { align: 'right' });
        doc.font('Helvetica').text(`FD Number: ${fd.fd_code}`, { align: 'right' });
        doc.text(`Issue Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
        doc.moveDown(1.5);
        const drawRow = (label, value, y, highlight = false) => {
            doc.font(highlight ? 'Helvetica-Bold' : 'Helvetica-Bold').fillColor('#333').text(label, 60, y, { width: 180 });
            doc.font(highlight ? 'Helvetica-Bold' : 'Helvetica').fillColor(highlight ? '#dc2626' : '#000000').text(value, 240, y);
        };
        let currY = doc.y;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Customer Information', 60, currY);
        currY += 20;
        doc.fontSize(10).fillColor('#000000');
        drawRow('Customer Name:', fd.customers.full_name, currY);
        currY += 15;
        drawRow('NIC Number:', fd.customers.nic_number, currY);
        currY += 15;
        drawRow('Address:', fd.customers.address || '-', currY);
        currY += 25;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Original FD Information', 60, currY);
        currY += 20;
        doc.fontSize(10);
        drawRow('Principal Amount:', `${settings.currency_symbol} ${Number(fd.principal_amount).toLocaleString()}`, currY);
        currY += 15;
        drawRow('Interest Rate:', `${fd.interest_rate}% p.a.`, currY);
        currY += 15;
        drawRow('Deposit Date:', new Date(fd.created_at).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Original Maturity Date:', new Date(fd.maturity_date).toLocaleDateString(), currY);
        currY += 25;
        const interestEarned = Math.max(0, Number(fd.payout_amount || fd.total_maturity_amount) - Number(fd.principal_amount));
        const penalty = Math.max(0, Number(fd.total_maturity_amount) - Number(fd.payout_amount || fd.total_maturity_amount));
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Early Closure & Settlement Details', 60, currY);
        currY += 20;
        doc.fontSize(10);
        drawRow('Closure Date:', new Date(fd.closed_at || new Date()).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Interest Earned:', `${settings.currency_symbol} ${interestEarned.toLocaleString()}`, currY);
        currY += 15;
        if (penalty > 0) {
            drawRow('Penalty Deducted:', `${settings.currency_symbol} ${penalty.toLocaleString()}`, currY, true);
            currY += 15;
        }
        // Highlight Final Settlement
        doc.rect(55, currY + 5, 300, 25).fill('#f0fdf4');
        doc.font('Helvetica-Bold').fillColor('#166534').text('Final Settlement Amount:', 60, currY + 12);
        doc.font('Helvetica-Bold').text(`${settings.currency_symbol} ${Number(fd.payout_amount || fd.total_maturity_amount).toLocaleString()}`, 240, currY + 12);
        currY += 45;
        doc.y = currY;
        // Declaration
        doc.fontSize(10).font('Helvetica-Oblique').fillColor('#333333');
        doc.text('This certificate confirms that the customer has requested early closure of the above Fixed Deposit before the scheduled maturity date. Applicable penalties, interest adjustments and deductions have been calculated according to company policies. The final settlement amount shown in this certificate has been paid to the customer in full and final settlement of the Fixed Deposit account.', 60, doc.y, { align: 'justify', width: doc.page.width - 120 });
        drawSignatures(doc, doc.page.height - 180);
        doc.fontSize(8).font('Helvetica').fillColor('#999999').text(`Generated By System | Date: ${new Date().toLocaleString()} | Ref: ${fd.id.substring(0, 8).toUpperCase()}`, 60, doc.page.height - 60, { align: 'center' });
        doc.end();
    }
    catch (err) {
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to generate certificate' });
    }
});
// GET /api/fixed-deposits/:id/maturity-closure-certificate
router.get('/:id/maturity-closure-certificate', async (req, res) => {
    try {
        const { data: fd } = await supabase_1.supabase
            .from('fixed_deposits')
            .select('*, customers(full_name, nic_number, address)')
            .eq('id', req.params.id)
            .eq('status', 'closed')
            .single();
        if (!fd) {
            res.status(404).json({ error: 'Closed fixed deposit not found' });
            return;
        }
        if (req.user?.role !== 'owner' && fd.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        const doc = new pdfkit_1.default({ margin: 40, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=FD-Maturity-${fd.fd_code}.pdf`);
        doc.pipe(res);
        addProfessionalCertificateFrame(doc, 'FIXED DEPOSIT MATURITY SETTLEMENT CERTIFICATE');
        doc.fontSize(10).font('Helvetica-Bold').text(`Certificate No: MAT-${fd.fd_code}`, 60, doc.y, { align: 'right' });
        doc.font('Helvetica').text(`FD Number: ${fd.fd_code}`, { align: 'right' });
        doc.text(`Issue Date: ${new Date().toLocaleDateString()}`, { align: 'right' });
        doc.moveDown(1.5);
        const drawRow = (label, value, y) => {
            doc.font('Helvetica-Bold').fillColor('#333').text(label, 60, y, { width: 180 });
            doc.font('Helvetica').fillColor('#000').text(value, 240, y);
        };
        let currY = doc.y;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Customer Information', 60, currY);
        currY += 20;
        doc.fontSize(10);
        drawRow('Customer Name:', fd.customers.full_name, currY);
        currY += 15;
        drawRow('NIC Number:', fd.customers.nic_number, currY);
        currY += 15;
        drawRow('Address:', fd.customers.address || '-', currY);
        currY += 25;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Fixed Deposit Information', 60, currY);
        currY += 20;
        doc.fontSize(10);
        drawRow('Principal Amount:', `${settings.currency_symbol} ${Number(fd.principal_amount).toLocaleString()}`, currY);
        currY += 15;
        drawRow('Interest Rate:', `${fd.interest_rate}% p.a.`, currY);
        currY += 15;
        drawRow('Deposit Date:', new Date(fd.created_at).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Maturity Date:', new Date(fd.maturity_date).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Deposit Period:', `${fd.term_months} Months`, currY);
        currY += 25;
        const totalInterest = Number(fd.total_maturity_amount) - Number(fd.principal_amount);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Settlement Summary', 60, currY);
        currY += 20;
        doc.fontSize(10);
        drawRow('Settlement Date:', new Date(fd.closed_at || new Date()).toLocaleDateString(), currY);
        currY += 15;
        drawRow('Total Interest Earned:', `${settings.currency_symbol} ${totalInterest.toLocaleString()}`, currY);
        currY += 15;
        // Highlight Final Settlement
        doc.rect(55, currY + 5, 300, 25).fill('#f0fdf4');
        doc.font('Helvetica-Bold').fillColor('#166534').text('Total Maturity Amount Paid:', 60, currY + 12);
        doc.font('Helvetica-Bold').text(`${settings.currency_symbol} ${Number(fd.total_maturity_amount).toLocaleString()}`, 240, currY + 12);
        currY += 45;
        doc.y = currY;
        // Declaration
        doc.fontSize(10).font('Helvetica-Oblique').fillColor('#333333');
        doc.text('This certificate confirms that the above Fixed Deposit has successfully completed its full investment period and has reached maturity. The customer has received the full maturity value including the applicable interest earnings in accordance with the terms and conditions agreed at the commencement of the Fixed Deposit.', 60, doc.y, { align: 'justify', width: doc.page.width - 120 });
        drawSignatures(doc, doc.page.height - 180);
        doc.fontSize(8).font('Helvetica').fillColor('#999999').text(`Generated By System | Date: ${new Date().toLocaleString()} | Ref: ${fd.id.substring(0, 8).toUpperCase()}`, 60, doc.page.height - 60, { align: 'center' });
        doc.end();
    }
    catch (err) {
        if (!res.headersSent)
            res.status(500).json({ error: 'Failed to generate certificate' });
    }
});
exports.default = router;
//# sourceMappingURL=fixed_deposits.js.map