import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
interface AuditOptions {
    action: string;
    entityType: string;
    getEntityId?: (req: AuthRequest) => string | undefined;
    getEntityCode?: (req: AuthRequest, resBody?: Record<string, unknown>) => string | undefined;
    getDescription?: (req: AuthRequest) => string;
}
export declare const auditLog: (options: AuditOptions) => (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export {};
//# sourceMappingURL=auditLog.d.ts.map