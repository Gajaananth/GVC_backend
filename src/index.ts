import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import customerRoutes from './routes/customers';
import loanRoutes from './routes/loans';
import paymentRoutes from './routes/payments';
import savingsRoutes from './routes/savings';
import dashboardRoutes from './routes/dashboard';
import dueRoutes from './routes/due';
import reportRoutes from './routes/reports';
import logRoutes from './routes/logs';
import settingsRoutes from './routes/settings';
import uploadRoutes from './routes/uploads';
import approvalRoutes from './routes/approvals';
import collectionRoutes from './routes/collections';
import formRoutes from './routes/forms';
import documentsRoutes from './routes/documents';
import notificationsRoutes from './routes/notifications';
import importExportRoutes from './routes/import-export';
import searchRoutes from './routes/search';
import cronRoutes from './routes/cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Auth endpoints get stricter rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use(requestLogger);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'GVC Finance API' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/savings', savingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/due', dueRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/import-export', importExportRoutes);
app.use('/api/search', searchRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`🚀 GVC Finance API running on port ${PORT}`);
  logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
