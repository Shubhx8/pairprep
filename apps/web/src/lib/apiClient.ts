import { ApiErrorResponseSchema } from "@pairprep/shared";

export const CSRF_HEADER_NAME = "X-Requested-With";
export const CSRF_HEADER_VALUE = "pairprep";

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly retryAfterSec?: number;
  readonly fields?: Record<string, string>;

  constructor(params: {
    message: string;
    code: string;
    status: number;
    requestId?: string;
    retryAfterSec?: number;
    fields?: Record<string, string>;
  }) {
    super(params.message);
    this.name = "ApiClientError";
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.retryAfterSec = params.retryAfterSec;
    this.fields = params.fields;
  }
}

export interface ApiRequestOptions extends RequestInit {
  idempotencyKey?: string;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  // Standard JSON header if body present and not already specified
  if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Defense-in-depth CSRF header on state-changing operations
  if (STATE_CHANGING_METHODS.has(method)) {
    headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  }

  // Optional Idempotency-Key
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  // Resolve API path with /api/v1 prefix if relative
  const url = path.startsWith("http")
    ? path
    : path.startsWith("/api/")
      ? path
      : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "include", // Ensure session/guest cookies are included
  });

  if (!res.ok) {
    let errorCode = "UNKNOWN_ERROR";
    let errorMessage = `HTTP request failed with status ${res.status}`;
    let requestId: string | undefined = res.headers.get("x-request-id") ?? undefined;
    let fields: Record<string, string> | undefined;

    // Parse Retry-After header for 429
    let retryAfterSec: number | undefined;
    const retryHeader = res.headers.get("retry-after");
    if (retryHeader) {
      const parsed = parseInt(retryHeader, 10);
      if (!isNaN(parsed)) {
        retryAfterSec = parsed;
      }
    }

    try {
      const data = await res.json();
      const parsed = ApiErrorResponseSchema.safeParse(data);
      if (parsed.success) {
        errorCode = parsed.data.error.code;
        errorMessage = parsed.data.error.message;
        requestId = parsed.data.error.requestId ?? requestId;
        fields = parsed.data.error.fields;
      }
    } catch {
      // Body not JSON, keep status message
    }

    throw new ApiClientError({
      message: errorMessage,
      code: errorCode,
      status: res.status,
      requestId,
      retryAfterSec,
      fields,
    });
  }

  // If 204 No Content, return undefined
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return (await res.json()) as T;
}

export const apiClient = {
  get<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: "GET" });
  },

  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return apiRequest<T>(path, {
      ...options,
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return apiRequest<T>(path, {
      ...options,
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  delete<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return apiRequest<T>(path, { ...options, method: "DELETE" });
  },
};
