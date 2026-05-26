import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { supabase } from '../config/supabase';

interface AuditOptions {
  action: string;
  entityType: string;
  getEntityId?: (req: AuthRequest) => string | undefined;
  getEntityCode?: (req: AuthRequest, resBody?: Record<string, unknown>) => string | undefined;
  getDescription?: (req: AuthRequest) => string;
}

export const auditLog = (options: AuditOptions) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const originalJson = res.json.bind(res);
    
    res.json = (body: unknown) => {
      // Log after response is sent
      if (res.statusCode < 400 && req.user) {
        const entityId = options.getEntityId ? options.getEntityId(req) : undefined;
        const entityCode = options.getEntityCode ? options.getEntityCode(req, body as Record<string, unknown>) : undefined;
        const description = options.getDescription ? options.getDescription(req) : `${options.action} ${options.entityType}`;

        supabase.from('activity_logs').insert({
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
        }).then(() => {}).catch(() => {});
      }
      return originalJson(body);
    };

    next();
  };
};
