import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import app from "../index.js";
import { createRateLimiter } from "../middleware/rateLimiter.js";
import { errorHandler } from "../middleware/errorHandler.js";

describe("Security Headers, Limits & Rate Limiting (T01)", () => {
  it("security: sets standard helmet security headers and Content-Security-Policy-Report-Only", async () => {
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    // Standard Helmet headers
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // CSP Report-Only for Monaco editor compatibility
    expect(res.headers["content-security-policy-report-only"]).toBeDefined();
    expect(res.headers["content-security-policy-report-only"]).toContain(
      "default-src 'self'"
    );
  });

  it("limits: rejects JSON request bodies exceeding 100 KB with 413 or standard error shape", async () => {
    // Generate a payload exceeding 100 KB (110 KB string)
    const largeString = "x".repeat(110 * 1024);
    const res = await request(app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ title: largeString }));

    expect(res.status).toBe(413);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.error.message).toContain("100 KB");
  });

  it("limits: rejects unsupported content-type headers on POST/PATCH requests", async () => {
    const res = await request(app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/xml")
      .send("<xml><title>My Room</title></xml>");

    expect(res.status).toBe(415);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(res.body.error.message).toContain("application/json");
  });

  it("limits: rejects gzip compressed body with 415 UNSUPPORTED_MEDIA_TYPE (inflate: false)", async () => {
    const zlib = await import("node:zlib");
    const compressed = zlib.gzipSync(JSON.stringify({ title: "Gzipped Room" }));

    const res = await request(app)
      .post("/api/v1/rooms")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send(compressed);

    expect(res.status).toBe(415);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("cors: disallowed origins do not return 500 and omit Access-Control-Allow-Origin header", async () => {
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://unauthorized-evil-domain.com");

    expect(res.status).not.toBe(500);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rateLimit: returns 429 with Retry-After header and standard error shape after exceeding limit", async () => {
    // Create an isolated sub-app with low max threshold to test rate limiting deterministically
    const testApp = express();
    const isolatedLimiter = createRateLimiter({
      max: 5,
      windowMs: 60 * 1000,
    });
    testApp.use(isolatedLimiter);
    testApp.get("/rate-test", (_req, res) => {
      res.status(200).send("ok");
    });
    testApp.use(errorHandler);

    // Hit the endpoint 5 times (allowed)
    for (let i = 0; i < 5; i++) {
      const res = await request(testApp).get("/rate-test");
      expect(res.status).toBe(200);
    }

    // The 6th request should be blocked with 429
    const blockedRes = await request(testApp).get("/rate-test");
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers["retry-after"]).toBeDefined();
    expect(parseInt(blockedRes.headers["retry-after"]!, 10)).toBeGreaterThan(0);
    expect(blockedRes.body.error).toBeDefined();
    expect(blockedRes.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(blockedRes.body.error.requestId).toBeDefined();
  });
});
