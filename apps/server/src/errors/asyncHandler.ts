import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an async route handler to forward unhandled promise rejections to the central error middleware.
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
