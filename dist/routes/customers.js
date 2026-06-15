"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const pdfkit_1 = __importDefault(require("pdfkit"));
const pdfTableGenerator_1 = require("../utils/pdfTableGenerator");
const date_fns_1 = require("date-fns");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const customerSchema = zod_1.z.object({
    full_name: zod_1.z.string().min(2),
    nic_number: zod_1.z.string().min(9),
    phone: zod_1.z.string().min(9),
    email: zod_1.z.string().email().optional().nullable(),
    address: zod_1.z.string().min(5),
    date_of_birth: zod_1.z.string().optional().nullable(),
    gender: zod_1.z.enum(['male', 'female', 'other']).optional().nullable(),
    occupation: zod_1.z.string().optional().nullable(),
    monthly_income: zod_1.z.number().optional().nullable(),
    branch_id: zod_1.z.string().uuid().optional(),
    photo_url: zod_1.z.string().url().min(1),
    nic_front_url: zod_1.z.string().url().min(1),
    nic_back_url: zod_1.z.string().url().min(1),
    home_photo_url: zod_1.z.string().optional().nullable(),
    shop_photo_url: zod_1.z.string().optional().nullable(),
    application_form_url: zod_1.z.string().optional().nullable(),
    registered_by_staff_id: zod_1.z.string().uuid().optional().nullable(),
    assigned_staff_id: zod_1.z.string().uuid().optional().nullable(),
    notes: zod_1.z.string().optional().nullable()
});
// GET /api/customers — all roles (staff = view only)
router.get('/', async (req, res) => {
    const { search, status, page = '1', limit = '20' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const offset = (pageNum - 1) * limitNum;
    let query = supabase_1.supabase
        .from('customers')
        .select('*, loans(id, loan_code, status, remaining_balance, approval_status), assigned_staff:users!assigned_staff_id(id, full_name)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1);
    // Add branch filter for non-owner roles
    if (req.user?.role !== 'owner') {
        query = query.eq('branch_id', req.user.branch_id);
    }
    // Staff may only view customers assigned to them
    if (req.user?.role === 'staff') {
        query = query.eq('assigned_staff_id', req.user.id);
    }
    if (search) {
        const safeSearch = search.replace(/"/g, '');
        query = query.or(`full_name.ilike."%${safeSearch}%",nic_number.ilike."%${safeSearch}%",phone.ilike."%${safeSearch}%",customer_code.ilike."%${safeSearch}%"`);
    }
    if (status === 'active') {
        query = query.eq('is_active', true);
    }
    else if (status === 'inactive') {
        query = query.eq('is_active', false);
    }
    const { data, error, count } = await query;
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});
// GET /api/customers/:id
router.get('/:id', async (req, res) => {
    const { data: customer, error } = await supabase_1.supabase
        .from('customers')
        .select('*')
        .eq('id', req.params.id)
        .single();
    if (error || !customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
    }
    // Enforce branch isolation for non-owners
    if (req.user?.role !== 'owner' && customer.branch_id !== req.user?.branch_id) {
        res.status(403).json({ error: 'Access to customer denied for your branch' });
        return;
    }
    // Staff may only access customers assigned to them
    if (req.user?.role === 'staff' && customer.assigned_staff_id !== req.user.id) {
        res.status(403).json({ error: 'Access to customer denied' });
        return;
    }
    const { data: loans } = await supabase_1.supabase
        .from('loans')
        .select(`
      id, loan_code, principal_amount, remaining_balance, status, approval_status,
      start_date, end_date, next_due_date,
      applied_by_user:users!applied_by(id, full_name),
      in_charge_user:users!in_charge_user_id(id, full_name)
    `)
        .eq('customer_id', req.params.id)
        .order('created_at', { ascending: false });
    const { data: savings } = await supabase_1.supabase
        .from('savings_accounts')
        .select('id, account_code, account_type, balance, interest_rate, is_active')
        .eq('customer_id', req.params.id)
        .order('created_at', { ascending: false });
    const { data: documents } = await supabase_1.supabase
        .from('customer_documents')
        .select('id, document_type, file_url, file_name, uploaded_at')
        .eq('customer_id', req.params.id)
        .order('uploaded_at', { ascending: false });
    res.json({ data: { ...customer, loans: loans || [], savings: savings || [], documents: documents || [] } });
});
const multer_1 = __importDefault(require("multer"));
const storage_1 = require("../utils/storage");
const faceDetection_1 = require("../utils/faceDetection");
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});
// POST /api/customers/fd - Create a Fixed Deposit customer (no face photo needed)
router.post('/fd', auth_1.requireCustomerAdmin, upload.fields([
    { name: 'nic_front', maxCount: 1 },
    { name: 'nic_back', maxCount: 1 }
]), async (req, res) => {
    try {
        const files = req.files;
        if (!files?.nic_front?.[0] || !files?.nic_back?.[0]) {
            res.status(400).json({ error: 'Missing required NIC images. NIC Front and NIC Back are mandatory for FD customers.' });
            return;
        }
        const schemaWithoutUrls = customerSchema.omit({
            photo_url: true, nic_front_url: true, nic_back_url: true,
            home_photo_url: true, shop_photo_url: true, application_form_url: true
        });
        const parsedBody = {
            ...req.body,
            monthly_income: req.body.monthly_income ? Number(req.body.monthly_income) : undefined
        };
        const body = schemaWithoutUrls.parse(parsedBody);
        const branchId = req.user?.role === 'owner' ? body.branch_id : req.user.branch_id;
        if (req.user?.role !== 'owner' && !branchId) {
            res.status(400).json({ error: 'Branch selection is required' });
            return;
        }
        const { registered_by_staff_id, assigned_staff_id, ...customerFields } = body;
        const staffId = assigned_staff_id || registered_by_staff_id;
        const { data: customer, error: insertError } = await supabase_1.supabase
            .from('customers')
            .insert({
            ...customerFields,
            registered_by_staff_id: registered_by_staff_id || staffId || null,
            assigned_staff_id: staffId || null,
            branch_id: branchId,
            created_by: req.user.id,
            photo_url: 'none', // Not required for FD
            nic_front_url: 'pending',
            nic_back_url: 'pending'
        })
            .select()
            .single();
        if (insertError) {
            if (insertError.code === '23505')
                res.status(409).json({ error: 'NIC number already exists' });
            else
                res.status(500).json({ error: insertError.message });
            return;
        }
        try {
            const nicFrontUpload = await (0, storage_1.uploadCustomerFile)(customer.id, 'nic_front', files.nic_front[0]);
            const nicBackUpload = await (0, storage_1.uploadCustomerFile)(customer.id, 'nic_back', files.nic_back[0]);
            const { data: updatedCustomer, error: updateError } = await supabase_1.supabase
                .from('customers')
                .update({
                nic_front_url: nicFrontUpload.url,
                nic_back_url: nicBackUpload.url,
            })
                .eq('id', customer.id)
                .select()
                .single();
            if (updateError)
                throw updateError;
            await supabase_1.supabase.from('activity_logs').insert({
                user_id: req.user.id, user_name: req.user.full_name, user_role: req.user.role,
                action: 'CREATE', entity_type: 'customer',
                entity_id: customer.id, entity_code: customer.customer_code,
                branch_id: req.user.branch_id,
                description: `Created FD customer: ${customer.full_name}`
            });
            res.status(201).json({ data: updatedCustomer, message: 'FD Customer created successfully' });
        }
        catch (uploadErr) {
            await supabase_1.supabase.from('customers').delete().eq('id', customer.id);
            throw new Error(`Failed to upload NIC images: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}`);
        }
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create FD customer' });
    }
});
// POST /api/customers — admin/owner only (staff cannot create)
router.post('/', auth_1.requireCustomerAdmin, upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'nic_front', maxCount: 1 },
    { name: 'nic_back', maxCount: 1 },
    { name: 'home_photo', maxCount: 1 },
    { name: 'shop_photo', maxCount: 1 },
    { name: 'application_form', maxCount: 1 },
    { name: 'other_photo_1', maxCount: 1 },
    { name: 'other_photo_2', maxCount: 1 },
    { name: 'other_photo_3', maxCount: 1 },
    { name: 'other_photo_4', maxCount: 1 },
    { name: 'other_photo_5', maxCount: 1 }
]), async (req, res) => {
    try {
        const files = req.files;
        // Validate that critical image files are provided in the upload
        if (!files?.photo?.[0] || !files?.nic_front?.[0] || !files?.nic_back?.[0]) {
            res.status(400).json({ error: 'Missing required profile or identification images. Face photo, NIC Front, and NIC Back are mandatory.' });
            return;
        }
        // Validate that the photo contains exactly one clear face
        const faceValidation = await (0, faceDetection_1.validateFacePhoto)(files.photo[0].buffer);
        if (!faceValidation.valid) {
            res.status(400).json({ error: faceValidation.reason || 'Please upload a clear customer face photo.' });
            return;
        }
        // Since it's multipart/form-data, req.body fields are strings.
        // Parse them carefully using our schema but omitting the URL fields since they will be generated.
        const schemaWithoutUrls = customerSchema.omit({
            photo_url: true,
            nic_front_url: true,
            nic_back_url: true,
            home_photo_url: true,
            shop_photo_url: true,
            application_form_url: true
        });
        // Need to parse stringified numbers if needed
        const parsedBody = {
            ...req.body,
            branch_id: req.body.branch_id ? req.body.branch_id : undefined,
            assigned_staff_id: req.body.assigned_staff_id ? req.body.assigned_staff_id : undefined,
            registered_by_staff_id: req.body.registered_by_staff_id ? req.body.registered_by_staff_id : undefined,
            monthly_income: req.body.monthly_income ? Number(req.body.monthly_income) : undefined
        };
        const body = schemaWithoutUrls.parse(parsedBody);
        let branchId = req.user?.role === 'owner' ? body.branch_id : req.user.branch_id;
        if (req.user?.role !== 'owner' && !branchId) {
            res.status(400).json({ error: 'Branch selection is required for customer creation' });
            return;
        }
        if (req.user?.role !== 'owner' && body.branch_id && body.branch_id !== req.user.branch_id) {
            res.status(403).json({ error: 'Cannot create customers for another branch' });
            return;
        }
        const { registered_by_staff_id, assigned_staff_id, ...customerFields } = body;
        const staffId = assigned_staff_id || registered_by_staff_id;
        if (staffId) {
            const { data: staff } = await supabase_1.supabase
                .from('users')
                .select('id, role, branch_id')
                .eq('id', staffId)
                .single();
            if (!staff || !['staff', 'admin'].includes(staff.role)) {
                res.status(400).json({ error: 'Invalid staff member for assignment' });
                return;
            }
            if (!branchId) {
                branchId = staff.branch_id;
            }
            if (branchId && staff.branch_id !== branchId) {
                res.status(400).json({ error: 'Invalid staff member for assignment' });
                return;
            }
        }
        const { data: customer, error: insertError } = await supabase_1.supabase
            .from('customers')
            .insert({
            ...customerFields,
            registered_by_staff_id: registered_by_staff_id || staffId || null,
            assigned_staff_id: staffId || null,
            branch_id: branchId,
            created_by: req.user.id,
            photo_url: 'pending', // Temporary placeholder
            nic_front_url: 'pending',
            nic_back_url: 'pending'
        })
            .select()
            .single();
        if (insertError) {
            if (insertError.code === '23505') {
                res.status(409).json({ error: 'NIC number already exists' });
            }
            else {
                res.status(500).json({ error: insertError.message });
            }
            return;
        }
        // Now upload the files to storage using the generated customer ID
        try {
            const photoUpload = await (0, storage_1.uploadCustomerFile)(customer.id, 'photo', files.photo[0]);
            const nicFrontUpload = await (0, storage_1.uploadCustomerFile)(customer.id, 'nic_front', files.nic_front[0]);
            const nicBackUpload = await (0, storage_1.uploadCustomerFile)(customer.id, 'nic_back', files.nic_back[0]);
            const homePhotoUpload = files.home_photo?.[0] ? await (0, storage_1.uploadCustomerFile)(customer.id, 'home_photo', files.home_photo[0]) : null;
            const shopPhotoUpload = files.shop_photo?.[0] ? await (0, storage_1.uploadCustomerFile)(customer.id, 'shop_photo', files.shop_photo[0]) : null;
            const appFormUpload = files.application_form?.[0] ? await (0, storage_1.uploadCustomerFile)(customer.id, 'application_form', files.application_form[0]) : null;
            const updateData = {
                photo_url: photoUpload.url,
                nic_front_url: nicFrontUpload.url,
                nic_back_url: nicBackUpload.url,
            };
            if (homePhotoUpload)
                updateData.home_photo_url = homePhotoUpload.url;
            if (shopPhotoUpload)
                updateData.shop_photo_url = shopPhotoUpload.url;
            if (appFormUpload)
                updateData.application_form_url = appFormUpload.url;
            const { data: updatedCustomer, error: updateError } = await supabase_1.supabase
                .from('customers')
                .update(updateData)
                .eq('id', customer.id)
                .select()
                .single();
            if (updateError)
                throw updateError;
            // Handle "other" photos
            for (let i = 1; i <= 5; i++) {
                const otherFile = files[`other_photo_${i}`]?.[0];
                if (otherFile) {
                    const uploadRes = await (0, storage_1.uploadCustomerFile)(customer.id, 'other', otherFile);
                    await supabase_1.supabase.from('customer_documents').insert({
                        customer_id: customer.id,
                        document_type: 'other',
                        file_url: uploadRes.url,
                        file_name: otherFile.originalname,
                        mime_type: otherFile.mimetype,
                        uploaded_by: req.user.id
                    });
                }
            }
            await supabase_1.supabase.from('activity_logs').insert({
                user_id: req.user.id, user_name: req.user.full_name, user_role: req.user.role,
                action: 'CREATE', entity_type: 'customer',
                entity_id: customer.id, entity_code: customer.customer_code,
                branch_id: req.user.branch_id,
                description: `Created customer with files: ${customer.full_name}`
            });
            res.status(201).json({ data: updatedCustomer, message: 'Customer and required documents created successfully' });
        }
        catch (uploadErr) {
            // If uploads fail, we should probably rollback the customer creation or mark it as inactive/error
            await supabase_1.supabase.from('customers').delete().eq('id', customer.id);
            throw new Error(`Failed to upload images: ${uploadErr instanceof Error ? uploadErr.message : 'Unknown error'}`);
        }
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            const errorMsg = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
            res.status(400).json({ error: `Validation error: ${errorMsg}`, details: err.errors });
            return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create customer' });
    }
});
// PUT /api/customers/:id — admin/owner only
router.put('/:id', auth_1.requireCustomerAdmin, async (req, res) => {
    try {
        const existing = await supabase_1.supabase
            .from('customers')
            .select('id, branch_id, assigned_staff_id, customer_code, full_name')
            .eq('id', req.params.id)
            .single();
        if (existing.error || !existing.data) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
        const customer = existing.data;
        if (req.user?.role !== 'owner' && customer.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Cannot update customer from another branch' });
            return;
        }
        const user = req.user;
        const body = customerSchema.partial().parse(req.body);
        if (user.role !== 'owner' && body.branch_id && body.branch_id !== user.branch_id) {
            res.status(403).json({ error: 'Cannot move customer to another branch' });
            return;
        }
        const { registered_by_staff_id: _omit, ...updateFields } = body;
        const updatePayload = { ...updateFields, updated_by: user.id };
        if (user.role !== 'owner')
            delete updatePayload.branch_id;
        const { data, error } = await supabase_1.supabase
            .from('customers')
            .update(updatePayload)
            .eq('id', req.params.id)
            .select()
            .single();
        if (error || !data) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id, user_name: req.user.full_name, user_role: req.user.role,
            action: 'UPDATE', entity_type: 'customer',
            entity_id: data.id, entity_code: data.customer_code,
            branch_id: customer.branch_id,
            description: `Updated customer: ${data.full_name}`
        });
        res.json({ data, message: 'Customer updated successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            const errorMsg = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
            res.status(400).json({ error: `Validation error: ${errorMsg}`, details: err.errors });
            return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update customer' });
    }
});
// DELETE /api/customers/:id — admin/owner only
router.delete('/:id', auth_1.requireCustomerAdmin, async (req, res) => {
    const { data: activeLoans } = await supabase_1.supabase
        .from('loans')
        .select('id')
        .eq('customer_id', req.params.id)
        .in('status', ['active', 'overdue', 'pending_approval'])
        .limit(1);
    if (activeLoans && activeLoans.length > 0) {
        res.status(400).json({ error: 'Cannot delete customer with active or pending loans' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('customers')
        .update({ is_active: false, updated_by: req.user.id })
        .eq('id', req.params.id)
        .select('id, customer_code, full_name')
        .single();
    if (error || !data) {
        res.status(404).json({ error: 'Customer not found' });
        return;
    }
    await supabase_1.supabase.from('activity_logs').insert({
        user_id: req.user.id, user_name: req.user.full_name, user_role: req.user.role,
        action: 'DELETE', entity_type: 'customer',
        entity_id: data.id, entity_code: data.customer_code,
        description: `Deactivated customer: ${data.full_name}`
    });
    res.json({ message: 'Customer deactivated successfully' });
});
router.get('/:id/loans', async (req, res) => {
    const { data: customer, error: customerError } = await supabase_1.supabase
        .from('customers')
        .select('branch_id')
        .eq('id', req.params.id)
        .single();
    if (customerError || !customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
    }
    if (req.user?.role !== 'owner' && customer.branch_id !== req.user?.branch_id) {
        res.status(403).json({ error: 'Access to customer loans denied for your branch' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('loans')
        .select('*, loan_payments(count)')
        .eq('customer_id', req.params.id)
        .order('created_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
router.get('/:id/savings', async (req, res) => {
    const { data: customer, error: customerError } = await supabase_1.supabase
        .from('customers')
        .select('branch_id')
        .eq('id', req.params.id)
        .single();
    if (customerError || !customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
    }
    if (req.user?.role !== 'owner' && customer.branch_id !== req.user?.branch_id) {
        res.status(403).json({ error: 'Access to customer savings denied for your branch' });
        return;
    }
    const { data, error } = await supabase_1.supabase
        .from('savings_accounts')
        .select('*, savings_transactions(*)')
        .eq('customer_id', req.params.id)
        .order('created_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
router.get('/:id/statement', async (req, res) => {
    try {
        const { data: customer, error: customerError } = await supabase_1.supabase
            .from('customers')
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (customerError || !customer) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
        if (req.user?.role !== 'owner' && customer.branch_id !== req.user?.branch_id) {
            res.status(403).json({ error: 'Access to customer denied' });
            return;
        }
        const { data: loans } = await supabase_1.supabase.from('loans').select('*, loan_payments(*)').eq('customer_id', req.params.id).order('created_at', { ascending: false });
        const { data: savings } = await supabase_1.supabase.from('savings_accounts').select('*, savings_transactions(*)').eq('customer_id', req.params.id).order('created_at', { ascending: false });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Statement-${customer.customer_code}.pdf`);
        const doc = new pdfkit_1.default({ margin: 30 });
        doc.pipe(res);
        const settings = await (0, pdfTableGenerator_1.getCompanySettings)();
        (0, pdfTableGenerator_1.addStandardHeader)(doc, 'CUSTOMER COMPREHENSIVE STATEMENT', settings, `Customer: ${customer.full_name} (${customer.customer_code})`);
        // Customer Info Section
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Customer Information');
        doc.fillColor('#000000').moveDown(0.3);
        doc.fontSize(10).font('Helvetica');
        doc.text(`NIC: ${customer.nic_number}`);
        doc.text(`Phone: ${customer.phone}`);
        doc.text(`Address: ${customer.address}`);
        doc.text(`Date Generated: ${(0, date_fns_1.format)(new Date(), 'yyyy-MM-dd HH:mm')}`);
        doc.moveDown(1.5);
        // Loans Section
        if (loans && loans.length > 0) {
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Loan Accounts');
            doc.fillColor('#000000').moveDown(0.5);
            const loanCols = [
                { header: 'Loan Code', key: 'loan_code', width: 100 },
                { header: 'Status', key: 'status', width: 80 },
                { header: 'Principal', key: 'principal', width: 100, align: 'right' },
                { header: 'Payable', key: 'payable', width: 100, align: 'right' },
                { header: 'Balance', key: 'balance', width: 100, align: 'right' },
            ];
            const loanRows = loans.map(l => ({
                loan_code: l.loan_code,
                status: l.status.toUpperCase(),
                principal: Number(l.principal_amount).toFixed(2),
                payable: Number(l.total_payable).toFixed(2),
                balance: Number(l.remaining_balance).toFixed(2),
            }));
            (0, pdfTableGenerator_1.drawTable)(doc, loanCols, loanRows, settings, 'CUSTOMER STATEMENT');
            doc.moveDown(1.5);
        }
        // Savings Section
        if (savings && savings.length > 0) {
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text('Savings Accounts');
            doc.fillColor('#000000').moveDown(0.5);
            const savCols = [
                { header: 'Account', key: 'account_code', width: 100 },
                { header: 'Type', key: 'type', width: 80 },
                { header: 'Rate', key: 'rate', width: 60, align: 'right' },
                { header: 'Balance', key: 'balance', width: 100, align: 'right' },
            ];
            const savRows = savings.map(s => ({
                account_code: s.account_code,
                type: s.account_type.toUpperCase(),
                rate: `${s.interest_rate}%`,
                balance: Number(s.balance).toFixed(2),
            }));
            (0, pdfTableGenerator_1.drawTable)(doc, savCols, savRows, settings, 'CUSTOMER STATEMENT');
            doc.moveDown(1.5);
        }
        doc.fontSize(9).fillColor('#6b7280').text('This is a computer-generated document.', { align: 'center' });
        doc.end();
    }
    catch (err) {
        console.error('Statement error:', err);
        res.status(500).json({ error: 'Failed to generate statement' });
    }
});
exports.default = router;
//# sourceMappingURL=customers.js.map