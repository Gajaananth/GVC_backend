import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    full_name: string;
    user_code: string;
  };
}

export const authenticateJWT = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization token required' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string; email: string; role: string; full_name: string; user_code: string;
    };

    // Verify user still exists and is active
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role, full_name, user_code, is_active')
      .eq('id', decoded.id)
      .single();

    if (error || !user || !user.is_active) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.user = { id: user.id, email: user.email, role: user.role, full_name: user.full_name, user_code: user.user_code };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
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

// Middleware: owner or admin only
export const requireAdmin = requireRole('owner', 'admin');
// Admin + owner for customer create & document uploads (staff cannot)
export const requireCustomerAdmin = requireRole('owner', 'admin');
// Middleware: any authenticated user except view_only can write (payments, etc.)
export const requireWrite = requireRole('owner', 'admin', 'staff');
// Middleware: owner only
export const requireOwner = requireRole('owner');
