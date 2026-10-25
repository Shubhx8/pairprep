import { Request, Response, NextFunction } from "express";

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "pairprep";

/**
 * PRD 6.1 / T04: Defense-in-depth CSRF Protection
 * All state-changing requests require custom header 'X-Requested-With: pairprep'.
 * Rejects with 403 and code 'CSRF_REJECTED' if missing or mismatched,
 * evaluating at perimeter before authentication checks.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  const headerVal = req.header(CSRF_HEADER_NAME);
  if (headerVal !== CSRF_HEADER_VALUE) {
    res.status(403).json({
      error: {
        code: "CSRF_REJECTED",
        message: "State-changing requests require 'X-Requested-With: pairprep' header",
        requestId:
          (res.getHeader("X-Request-Id") as string) ||
          (req.headers["x-request-id"] as string) ||
          (req as unknown as { id?: string }).id ||
          "",
      },
    });
    return;
  }

  next();
}
