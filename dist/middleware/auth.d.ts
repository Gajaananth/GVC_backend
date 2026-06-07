import { Request, Response, NextFunction } from 'express';
export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        role: string;
        full_name: string;
        user_code: string;
        branch_id: string;
        branch_name?: string;
    };
}
export declare const authenticateJWT: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export declare const requireRole: (...roles: string[]) => (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireBranchManager: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireOwnerOrBranchManager: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireAdmin: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireCustomerAdmin: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireWrite: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const requireOwner: (req: AuthRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map