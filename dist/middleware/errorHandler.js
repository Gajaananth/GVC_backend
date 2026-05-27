"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createError = exports.errorHandler = void 0;
const logger_1 = require("../utils/logger");
const errorHandler = (err, _req, res, _next) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal server error';
    logger_1.logger.error(`Error ${statusCode}: ${message}`, {
        stack: err.stack,
        code: err.code
    });
    res.status(statusCode).json({
        error: message,
        code: err.code,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
exports.errorHandler = errorHandler;
const createError = (message, statusCode = 500, code) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.code = code;
    return err;
};
exports.createError = createError;
//# sourceMappingURL=errorHandler.js.map