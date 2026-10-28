import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import { setupTestDb, teardownTestDb } from "../db/testDb.js";
import { passport } from "../../auth/passport.js";

describe("Auth Rate Limiting (T04 / PRD 6.1)", () => {
  beforeAll(async () => {
    await setupTestDb("auth_rate_limit");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(passport, "authenticate").mockImplementation(() => {
      return ((_req: Request, res: Response) => {
        res.redirect("https://accounts.google.com/o/oauth2/v2/auth");
      }) as unknown as ReturnType<typeof passport.authenticate>;
    });
  });

  it("rateLimit: enforces 10 requests per minute on /api/v1/auth/*", async () => {
    const ip = "192.168.1.100";
    const express = (await import("express")).default;
    const { createAuthRateLimiter } = await import("../../middleware/authRateLimiter.js");

    const testApp = express();
    testApp.use(createAuthRateLimiter({ limit: 10 }));
    testApp.get("/api/v1/auth/google", (_req, res) => {
      res.redirect("https://accounts.google.com/o/oauth2/v2/auth");
    });

    // 10 requests within 1 minute window must succeed (return 302 redirect)
    for (let i = 0; i < 10; i++) {
      const res = await request(testApp)
        .get("/api/v1/auth/google")
        .set("X-Forwarded-For", ip);

      expect(res.status).toBe(302);
    }

    // 11th request from same IP must receive HTTP 429 Too Many Requests
    const resBlocked = await request(testApp)
      .get("/api/v1/auth/google")
      .set("X-Forwarded-For", ip);

    expect(resBlocked.status).toBe(429);
    expect(resBlocked.body.error).toBeDefined();
    expect(resBlocked.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
