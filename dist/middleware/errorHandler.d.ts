import { Request, Response, NextFunction } from 'express';
export interface AppError extends Error {
    statusCode?: number;
    code?: string;
}
export declare const errorHandler: (err: AppError, _req: Request, res: Response, _next: NextFunction) => void;
export declare const createError: (message: string, statusCode?: number, code?: string) => AppError;
//# sourceMappingURL=errorHandler.d.ts.map