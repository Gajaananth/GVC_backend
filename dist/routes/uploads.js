"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const storage_1 = require("../utils/storage");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});
const docTypeSchema = zod_1.z.enum([
    'nic_front', 'nic_back', 'photo', 'application_form', 'home_photo', 'shop_photo', 'other'
]);
// POST /api/uploads/customers/:customerId — admin/owner only
router.post('/customers/:customerId', auth_1.requireCustomerAdmin, upload.single('file'), async (req, res) => {
    try {
        const documentType = docTypeSchema.parse(req.body.document_type);
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: 'File is required' });
            return;
        }
        const { data: customer } = await supabase_1.supabase
            .from('customers')
            .select('id, customer_code, full_name')
            .eq('id', req.params.customerId)
            .single();
        if (!customer) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
        const { url } = await (0, storage_1.uploadCustomerFile)(customer.id, documentType, file);
        await supabase_1.supabase.from('customer_documents').insert({
            customer_id: customer.id,
            document_type: documentType,
            file_url: url,
            file_name: file.originalname,
            mime_type: file.mimetype,
            uploaded_by: req.user.id
        });
        const field = storage_1.DOCUMENT_FIELD_MAP[documentType];
        if (field) {
            await supabase_1.supabase.from('customers').update({ [field]: url, updated_by: req.user.id }).eq('id', customer.id);
        }
        await supabase_1.supabase.from('activity_logs').insert({
            user_id: req.user.id,
            user_name: req.user.full_name,
            user_role: req.user.role,
            action: 'UPLOAD',
            entity_type: 'customer_document',
            entity_id: customer.id,
            entity_code: customer.customer_code,
            description: `Uploaded ${documentType} for ${customer.full_name}`
        });
        res.status(201).json({ data: { url, document_type: documentType }, message: 'Document uploaded' });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Invalid document type' });
            return;
        }
        res.status(400).json({ error: message });
    }
});
// GET /api/uploads/customers/:customerId/documents
router.get('/customers/:customerId/documents', async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('customer_documents')
        .select('*, users:uploaded_by(full_name)')
        .eq('customer_id', req.params.customerId)
        .order('uploaded_at', { ascending: false });
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data });
});
exports.default = router;
//# sourceMappingURL=uploads.js.map