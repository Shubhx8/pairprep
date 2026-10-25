import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Request, Response } from "express";
import app from "../../index.js";
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

  it("rateLimit: enforces 30 requests per minute on /api/v1/auth/*", async () => {
    const ip = "192.168.1.100";

    // 30 requests within 1 minute window must succeed (return 302 redirect)
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .get("/api/v1/auth/google")
        .set("X-Forwarded-For", ip);

      expect(res.status).toBe(302);
    }

    // 31st request from same IP must receive HTTP 429 Too Many Requests
    const resBlocked = await request(app)
      .get("/api/v1/auth/google")
      .set("X-Forwarded-For", ip);

    expect(resBlocked.status).toBe(429);
    expect(resBlocked.body.error).toBeDefined();
    expect(resBlocked.body.error.code).toBe("RATE_LIMITED");
  });
});
