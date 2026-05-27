"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("./utils/logger");
const errorHandler_1 = require("./middleware/errorHandler");
const requestLogger_1 = require("./middleware/requestLogger");
// Routes
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const customers_1 = __importDefault(require("./routes/customers"));
const loans_1 = __importDefault(require("./routes/loans"));
const payments_1 = __importDefault(require("./routes/payments"));
const savings_1 = __importDefault(require("./routes/savings"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const due_1 = __importDefault(require("./routes/due"));
const reports_1 = __importDefault(require("./routes/reports"));
const logs_1 = __importDefault(require("./routes/logs"));
const settings_1 = __importDefault(require("./routes/settings"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);
// Security middleware
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
// CORS
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);
// Auth endpoints get stricter rate limiting
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/', authLimiter);
// Body parsing
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// Request logging
app.use(requestLogger_1.requestLogger);
// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'GVC Finance API' });
});
// API Routes
app.use('/api/auth', auth_1.default);
app.use('/api/users', users_1.default);
app.use('/api/customers', customers_1.default);
app.use('/api/loans', loans_1.default);
app.use('/api/payments', payments_1.default);
app.use('/api/savings', savings_1.default);
app.use('/api/dashboard', dashboard_1.default);
app.use('/api/due', due_1.default);
app.use('/api/reports', reports_1.default);
app.use('/api/logs', logs_1.default);
app.use('/api/settings', settings_1.default);
// 404 handler
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});
// Global error handler
app.use(errorHandler_1.errorHandler);
app.listen(PORT, () => {
    logger_1.logger.info(`🚀 GVC Finance API running on port ${PORT}`);
    logger_1.logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});
exports.default = app;
//# sourceMappingURL=index.js.map