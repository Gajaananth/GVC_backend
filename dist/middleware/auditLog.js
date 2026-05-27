"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = void 0;
const supabase_1 = require("../config/supabase");
const auditLog = (options) => {
    return async (req, res, next) => {
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Log after response is sent
            if (res.statusCode < 400 && req.user) {
                const entityId = options.getEntityId ? options.getEntityId(req) : undefined;
                const entityCode = options.getEntityCode ? options.getEntityCode(req, body) : undefined;
                const description = options.getDescription ? options.getDescription(req) : `${options.action} ${options.entityType}`;
                supabase_1.supabase.from('activity_logs').insert({
                    user_id: req.user.id,
                    user_name: req.user.full_name,
                    user_role: req.user.role,
                    action: options.action,
                    entity_type: options.entityType,
                    entity_id: entityId,
                    entity_code: entityCode,
                    description,
                    ip_address: req.ip,
                    user_agent: req.get('user-agent')
                }).then(({ error }) => { if (error)
                    console.error('Audit log error:', error); });
            }
            return originalJson(body);
        };
        next();
    };
};
exports.auditLog = auditLog;
//# sourceMappingURL=auditLog.js.map