"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const multer_1 = __importDefault(require("multer"));
const csv_parse_1 = require("csv-parse");
const sync_1 = require("csv-stringify/sync");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
const stream_1 = require("stream");
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
// POST /api/import-export/import/customers
router.post('/import/customers', auth_1.requireOwner, upload.single('file'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }
    try {
        const results = [];
        const stream = stream_1.Readable.from(req.file.buffer);
        stream
            .pipe((0, csv_parse_1.parse)({ columns: true, skip_empty_lines: true }))
            .on('data', (data) => {
            results.push({
                full_name: data.full_name,
                nic_number: data.nic_number,
                phone: data.phone,
                address: data.address,
                customer_code: data.customer_code || undefined,
                created_by: req.user.id
            });
        })
            .on('end', async () => {
            const { data, error } = await supabase_1.supabase.from('customers').insert(results).select();
            if (error) {
                res.status(500).json({ error: error.message });
                return;
            }
            res.json({ message: `Successfully imported ${data.length} customers` });
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to process CSV' });
    }
});
// GET /api/import-export/export/customers
router.get('/export/customers', auth_1.requireOwner, async (req, res) => {
    const { data, error } = await supabase_1.supabase.from('customers').select('*');
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    const csv = (0, sync_1.stringify)(data || [], { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customers_export.csv');
    res.send(csv);
});
exports.default = router;
//# sourceMappingURL=import-export.js.map