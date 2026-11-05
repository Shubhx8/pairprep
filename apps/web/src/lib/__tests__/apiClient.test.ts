import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiClient,
  apiRequest,
  ApiClientError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
} from "../apiClient.js";

describe("apiClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("prepends /api/v1 to relative paths and includes credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ status: "ok" }),
    });
    global.fetch = mockFetch;

    const data = await apiClient.get<{ status: string }>("/healthz");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/healthz");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(data).toEqual({ status: "ok" });
  });

  it("attaches X-Requested-With: pairprep and Content-Type on POST requests", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ id: "123" }),
    });
    global.fetch = mockFetch;

    await apiClient.post("/rooms", { title: "Test Room" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ title: "Test Room" }));
  });

  it("attaches Idempotency-Key header when provided in options", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ id: "123" }),
    });
    global.fetch = mockFetch;

    await apiClient.post(
      "/rooms",
      { title: "Room" },
      { idempotencyKey: "test-uuid-key" }
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("test-uuid-key");
  });

  it("attaches CSRF header on PATCH and DELETE", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ updated: true }),
    });
    global.fetch = mockFetch;

    await apiClient.patch("/me", { displayName: "New Name" });
    const patchHeaders = new Headers(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers
    );
    expect(patchHeaders.get(CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);

    await apiClient.delete("/rooms/abc/members/123");
    const deleteHeaders = new Headers(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].headers
    );
    expect(deleteHeaders.get(CSRF_HEADER_NAME)).toBe(CSRF_HEADER_VALUE);
  });

  it("parses ApiErrorResponseSchema on failure and throws ApiClientError", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({
        "content-type": "application/json",
        "x-request-id": "req-xyz-123",
      }),
      json: async () => ({
        error: {
          code: "ROOM_NOT_FOUND",
          message: "The requested room does not exist",
          requestId: "req-xyz-123",
        },
      }),
    });
    global.fetch = mockFetch;

    await expect(apiClient.get("/rooms/missing-room")).rejects.toThrowError(
      ApiClientError
    );

    try {
      await apiClient.get("/rooms/missing-room");
    } catch (err) {
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("ROOM_NOT_FOUND");
      expect(apiErr.status).toBe(404);
      expect(apiErr.requestId).toBe("req-xyz-123");
      expect(apiErr.message).toBe("The requested room does not exist");
    }
  });

  it("parses Retry-After header on 429 rate limit into retryAfterSec", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({
        "content-type": "application/json",
        "retry-after": "45",
      }),
      json: async () => ({
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many room creation attempts. Please slow down.",
        },
      }),
    });
    global.fetch = mockFetch;

    try {
      await apiClient.post("/rooms", { title: "Spam" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(apiErr.retryAfterSec).toBe(45);
    }
  });

  it("handles 204 No Content cleanly returning undefined", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
    });
    global.fetch = mockFetch;

    const result = await apiRequest("/rooms/abc", { method: "DELETE" });
    expect(result).toBeUndefined();
  });
});
