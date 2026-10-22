/**
 * Base Application Error class with HTTP status code and stable machine-readable code.
 * Ensures all API errors map directly to the standardized error response shape:
 * { "error": { "code": "STABLE_CODE", "message": "...", "requestId": "..." } }
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields?: Record<string, string>;

  constructor(
    message: string,
    statusCode = 500,
    code = "INTERNAL_ERROR",
    fields?: Record<string, string>
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;

    // Maintains proper stack trace in V8 engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
