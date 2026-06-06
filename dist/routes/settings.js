"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const logger_1 = require("../utils/logger");
const zod_1 = require("zod");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
// GET /api/settings (owner only)
router.get('/', auth_1.requireOwner, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('company_settings')
        .select('*')
        .limit(1);
    if (error) {
        logger_1.logger.error('Supabase error on settings GET:', error);
        const isPermissionDenied = error.code === '42501' || (typeof error.message === 'string' && error.message.toLowerCase().includes('permission denied'));
        if (isPermissionDenied) {
            res.status(500).json({
                error: 'Database permission denied for `service_role` on table `company_settings`. Apply the required GRANTs as described in the migration README.',
                action: 'Run the SQL from database/README_MIGRATION.md: GRANT USAGE ON SCHEMA public TO service_role; GRANT SELECT ON public.company_settings TO service_role;'
            });
            return;
        }
        res.status(500).json({
            error: error.message || 'Failed to load settings',
            code: error.code,
            details: error.details,
            hint: error.hint
        });
        return;
    }
    const settings = Array.isArray(data) ? data[0] : data;
    if (!settings) {
        res.status(404).json({ error: 'Settings not found' });
        return;
    }
    res.json({ data: settings });
});
const settingsSchema = zod_1.z.object({
    company_name: zod_1.z.string().optional(),
    company_address: zod_1.z.string().optional(),
    company_phone: zod_1.z.string().optional(),
    company_email: zod_1.z.string().email().optional(),
    company_logo_url: zod_1.z.string().optional(),
    default_loan_interest_rate: zod_1.z.number().optional(),
    default_savings_interest_rate: zod_1.z.number().optional(),
    late_fee_percentage: zod_1.z.number().optional(),
    grace_period_days: zod_1.z.number().int().optional(),
    sms_enabled: zod_1.z.boolean().optional(),
    email_enabled: zod_1.z.boolean().optional()
});
// PUT /api/settings
router.put('/', auth_1.requireOwner, async (req, res) => {
    try {
        const body = settingsSchema.parse(req.body);
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        const { data, error } = await supabase_1.supabase
            .from('company_settings')
            .update({ ...body, updated_by: user.id })
            .neq('id', '00000000-0000-0000-0000-000000000000') // update all rows
            .select();
        if (error) {
            const isPermissionDenied = error.code === '42501' || (typeof error.message === 'string' && error.message.toLowerCase().includes('permission denied'));
            if (isPermissionDenied) {
                res.status(500).json({
                    error: 'Database permission denied for `service_role` on table `company_settings`. Apply the required GRANTs as described in the migration README.'
                });
                return;
            }
            res.status(500).json({ error: error.message });
            return;
        }
        const updatedSettings = Array.isArray(data) ? data[0] : data;
        if (!updatedSettings) {
            res.status(404).json({ error: 'Settings not found' });
            return;
        }
        res.json({ data: updatedSettings, message: 'Settings updated successfully' });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: 'Validation error', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Failed to update settings' });
    }
});
exports.default = router;
//# sourceMappingURL=settings.js.map