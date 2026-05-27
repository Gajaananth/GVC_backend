"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../config/supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticateJWT);
router.use(auth_1.requireAdmin);
// GET /api/logs - paginated activity logs with filters
router.get('/', async (req, res) => {
    const { user_id, action, entity_type, start_date, end_date, page = '1', limit = '50' } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const offset = (pageNum - 1) * limitNum;
    let query = supabase_1.supabase
        .from('activity_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1);
    if (user_id)
        query = query.eq('user_id', user_id);
    if (action)
        query = query.eq('action', action);
    if (entity_type)
        query = query.eq('entity_type', entity_type);
    if (start_date)
        query = query.gte('created_at', start_date);
    if (end_date)
        query = query.lte('created_at', `${end_date}T23:59:59`);
    const { data, error, count } = await query;
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ data, total: count, page: pageNum, limit: limitNum, totalPages: Math.ceil((count || 0) / limitNum) });
});
exports.default = router;
//# sourceMappingURL=logs.js.map