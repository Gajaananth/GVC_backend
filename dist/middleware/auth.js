"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireOwner = exports.requireWrite = exports.requireCustomerAdmin = exports.requireAdmin = exports.requireRole = exports.authenticateJWT = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const supabase_1 = require("../config/supabase");
const authenticateJWT = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Authorization token required' });
        return;
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        // Verify user still exists and is active
        const { data: user, error } = await supabase_1.supabase
            .from('users')
            .select('id, email, role, full_name, user_code, is_active, branch_id')
            .eq('id', decoded.id)
            .single();
        if (error || !user || !user.is_active) {
            res.status(401).json({ error: 'Invalid or expired token' });
            return;
        }
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role,
            full_name: user.full_name,
            user_code: user.user_code,
            branch_id: user.branch_id
        };
        next();
    }
    catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};
exports.authenticateJWT = authenticateJWT;
const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: 'Insufficient permissions for this action' });
            return;
        }
        next();
    };
};
exports.requireRole = requireRole;
// Middleware: owner or admin only
exports.requireAdmin = (0, exports.requireRole)('owner', 'admin', 'branch_manager', 'cashier');
// Admin + owner for customer create & document uploads (staff cannot)
exports.requireCustomerAdmin = (0, exports.requireRole)('owner', 'admin', 'branch_manager', 'cashier');
// Middleware: any authenticated user except view_only can write (payments, etc.)
exports.requireWrite = (0, exports.requireRole)('owner', 'admin', 'staff');
// Middleware: owner only
exports.requireOwner = (0, exports.requireRole)('owner');
//# sourceMappingURL=auth.js.map