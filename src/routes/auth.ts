import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { createError } from '../middleware/errorHandler';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const resetRequestSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(8)
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('is_active', true)
      .single();

    if (error || !user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Update last login
    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

    // Log activity
    await supabase.from('activity_logs').insert({
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      action: 'LOGIN',
      entity_type: 'session',
      description: 'User logged in',
      ip_address: req.ip,
      user_agent: req.get('user-agent')
    });

    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      full_name: user.full_name,
      user_code: user.user_code
    };

    const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, {
      expiresIn: process.env.JWT_EXPIRES_IN || '15m'
    } as jwt.SignOptions);

    const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
    } as jwt.SignOptions);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        user_code: user.user_code,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        mobile: user.mobile,
        address: user.address,
        avatar_url: user.avatar_url
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    throw createError('Login failed', 500);
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(401).json({ error: 'Refresh token required' });
    return;
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { id: string };

    const { data: user } = await supabase
      .from('users')
      .select('id, email, role, full_name, user_code, is_active')
      .eq('id', decoded.id)
      .eq('is_active', true)
      .single();

    if (!user) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name, user_code: user.user_code },
      process.env.JWT_SECRET!,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' } as jwt.SignOptions
    );

    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  // In a stateless JWT system, logout is handled client-side
  // Optionally: invalidate refresh tokens via a blocklist
  res.json({ message: 'Logged out successfully' });
});

// POST /api/auth/request-reset
router.post('/request-reset', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = resetRequestSchema.parse(req.body);

    const { data: user } = await supabase
      .from('users')
      .select('id, email, full_name')
      .eq('email', email.toLowerCase())
      .single();

    // Always return success to prevent email enumeration
    if (!user) {
      res.json({ message: 'If that email exists, a reset link has been sent.' });
      return;
    }

    const resetToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {
      expiresIn: '1h'
    } as jwt.SignOptions);

    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    await supabase
      .from('users')
      .update({ reset_token: resetToken, reset_token_expires_at: expiresAt })
      .eq('id', user.id);

    // TODO: Send email with reset link
    // await sendPasswordResetEmail(user.email, user.full_name, resetToken);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch {
    res.status(400).json({ error: 'Invalid request' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };

    const { data: user } = await supabase
      .from('users')
      .select('id, reset_token, reset_token_expires_at')
      .eq('id', decoded.id)
      .single();

    if (!user || user.reset_token !== token) {
      res.status(400).json({ error: 'Invalid or expired reset token' });
      return;
    }

    if (user.reset_token_expires_at && new Date(user.reset_token_expires_at) < new Date()) {
      res.status(400).json({ error: 'Reset token has expired' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await supabase
      .from('users')
      .update({ password_hash: passwordHash, reset_token: null, reset_token_expires_at: null })
      .eq('id', user.id);

    res.json({ message: 'Password reset successfully' });
  } catch {
    res.status(400).json({ error: 'Invalid or expired reset token' });
  }
});

export default router;
