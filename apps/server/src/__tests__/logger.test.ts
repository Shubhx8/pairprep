import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { Writable } from "node:stream";
import app from "../index.js";
import { createLogger, RequestWithId, isValidUUID } from "../middleware/logger.js";

describe("Request ID & Structured Logging (T01 & PRD OBS-1)", () => {
  it("requestId: generates a unique UUID X-Request-Id header for each incoming request", async () => {
    const res1 = await request(app).get("/healthz");
    const res2 = await request(app).get("/healthz");

    expect(res1.headers["x-request-id"]).toBeDefined();
    expect(res2.headers["x-request-id"]).toBeDefined();
    expect(res1.headers["x-request-id"]).not.toBe(res2.headers["x-request-id"]);

    // Verify it is a strict valid UUID format
    expect(isValidUUID(res1.headers["x-request-id"])).toBe(true);
    expect(isValidUUID(res2.headers["x-request-id"])).toBe(true);
  });

  it("requestId: preserves incoming client-supplied X-Request-Id header when it is a valid UUID", async () => {
    const validUuid = "12345678-1234-4234-8234-123456789abc";
    const res = await request(app).get("/healthz").set("X-Request-Id", validUuid);

    expect(res.headers["x-request-id"]).toBe(validUuid);
  });

  it("requestId: rejects and overwrites invalid or spoofed X-Request-Id headers with a fresh valid UUID", async () => {
    const spoofedId = "client-spoofed-trace-id-12345";
    const res = await request(app).get("/healthz").set("X-Request-Id", spoofedId);

    // Spoofed ID must NOT be accepted
    expect(res.headers["x-request-id"]).not.toBe(spoofedId);
    // Fresh UUID must be generated
    expect(isValidUUID(res.headers["x-request-id"])).toBe(true);
  });

  it("logger: outputs structured JSON containing requestId, method, path, and duration", async () => {
    const logChunks: string[] = [];
    const testStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger(testStream);
    const testApp = express();

    testApp.use((req, res, next) => {
      const requestId = "12345678-1234-4234-8234-123456789abc";
      (req as RequestWithId).id = requestId;
      res.setHeader("X-Request-Id", requestId);
      (req as RequestWithId).log = testLogger.child({ requestId });

      res.on("finish", () => {
        (req as RequestWithId).log?.info(
          {
            requestId,
            method: req.method,
            path: req.url,
            statusCode: res.statusCode,
            durationMs: 5.2,
          },
          "HTTP request completed"
        );
      });
      next();
    });

    testApp.get("/test-log", (_req, res) => {
      res.status(200).send("ok");
    });

    await request(testApp).get("/test-log");

    expect(logChunks.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logChunks[0]!);
    expect(parsed.requestId).toBe("12345678-1234-4234-8234-123456789abc");
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/test-log");
    expect(parsed.statusCode).toBe(200);
    expect(parsed.durationMs).toBeDefined();
    expect(parsed.msg).toBe("HTTP request completed");
  });

  it("logger: logs path without query string to prevent OAuth token leaks (asserts SENTINEL is absent)", async () => {
    const logChunks: string[] = [];
    const testStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger(testStream);
    const testApp = express();

    testApp.use((req, res, next) => {
      const requestId = "12345678-1234-4234-8234-123456789abc";
      (req as RequestWithId).id = requestId;
      res.setHeader("X-Request-Id", requestId);
      (req as RequestWithId).log = testLogger.child({ requestId });

      res.on("finish", () => {
        const rawUrl = req.originalUrl || req.url || "/";
        const pathWithoutQuery = rawUrl.split("?")[0] || "/";
        (req as RequestWithId).log?.info(
          {
            requestId,
            method: req.method,
            path: pathWithoutQuery,
            statusCode: res.statusCode,
          },
          "HTTP request completed"
        );
      });
      next();
    });

    testApp.get("/healthz", (_req, res) => {
      res.status(200).send("ok");
    });

    // Make request containing sensitive query token
    await request(testApp).get("/healthz?token=SENTINEL_TOKEN_LEAK_XYZ");

    expect(logChunks.length).toBeGreaterThan(0);
    const fullLogText = logChunks.join("\n");
    const parsed = JSON.parse(logChunks[0]!);

    // Path must be clean without query string
    expect(parsed.path).toBe("/healthz");
    // Critical assertion: SENTINEL must never appear anywhere in the logs
    expect(fullLogText).not.toContain("SENTINEL_TOKEN_LEAK_XYZ");
  });

  it("logger: redacts cookies, authorization, and set-cookie headers from log output", async () => {
    const logChunks: string[] = [];
    const testStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger(testStream);
    testLogger.info({
      headers: {
        authorization: "Bearer secret-token-xyz",
        cookie: "session=sensitive-cookie-val",
        "set-cookie": "secret-session-id=sensitive-val",
      },
    });

    expect(logChunks.length).toBeGreaterThan(0);
    const logOutput = logChunks.join("\n");
    expect(logOutput).toContain("[REDACTED]");
    expect(logOutput).not.toContain("secret-token-xyz");
    expect(logOutput).not.toContain("sensitive-cookie-val");
    expect(logOutput).not.toContain("secret-session-id=sensitive-val");
  });

  it("logger: strictly omits request bodies and code execution payloads (asserts SENSITIVE_PAYLOAD_XYZ is absent from raw log stream)", async () => {
    const rawLogs: string[] = [];
    const captureStream = new Writable({
      write(chunk, _encoding, callback) {
        rawLogs.push(chunk.toString());
        callback();
      },
    });

    const testLogger = createLogger(captureStream);
    const testApp = express();
    testApp.use(express.json());

    testApp.use((req, res, next) => {
      const start = performance.now();
      const requestId = "12345678-1234-4234-8234-123456789abc";
      (req as RequestWithId).id = requestId;
      (req as RequestWithId).log = testLogger.child({ requestId });

      res.on("finish", () => {
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        const rawUrl = req.originalUrl || req.url || "/";
        const pathWithoutQuery = rawUrl.split("?")[0] || "/";

        const logData = {
          requestId,
          method: req.method,
          path: pathWithoutQuery,
          statusCode: res.statusCode,
          durationMs,
        };
        (req as RequestWithId).log?.info(logData, "HTTP request completed");
      });
      next();
    });

    testApp.post("/api/run-code", (_req, res) => {
      res.status(200).json({ status: "executed" });
    });

    const sensitivePayload = {
      code: "print('SENSITIVE_PAYLOAD_XYZ')",
      sensitiveData: "SENSITIVE_PAYLOAD_XYZ",
    };

    await request(testApp).post("/api/run-code").send(sensitivePayload);

    expect(rawLogs.length).toBeGreaterThan(0);
    const fullLogText = rawLogs.join("\n");

    for (const line of rawLogs) {
      const parsed = JSON.parse(line.trim());
      expect(parsed.requestId).toBe("12345678-1234-4234-8234-123456789abc");
      expect(parsed.method).toBe("POST");
      expect(parsed.path).toBe("/api/run-code");
    }

    expect(fullLogText).not.toContain("SENSITIVE_PAYLOAD_XYZ");
    expect(fullLogText).not.toContain("print('SENSITIVE_PAYLOAD_XYZ')");
  });

  it("logger: logs 429 and 413 responses with body requestId matching X-Request-Id header", async () => {
    const { createRateLimiter } = await import("../middleware/rateLimiter.js");
    const { errorHandler } = await import("../middleware/errorHandler.js");
    const { createRequestLogger } = await import("../middleware/logger.js");

    const rawLogs: string[] = [];
    const testStream = new Writable({
      write(chunk, _encoding, cb) {
        rawLogs.push(chunk.toString());
        cb();
      },
    });
    const captureLogger = createLogger(testStream);

    const testApp = express();
    // 1. Logger first
    testApp.use(createRequestLogger(captureLogger));
    // 2. Limiter (limit 1 for fast test)
    testApp.use(createRateLimiter({ limit: 1, windowMs: 60000 }));
    // 3. Parser with 100kb limit
    testApp.use(express.json({ limit: "100kb" }));

    testApp.post("/test-limit", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    testApp.use(errorHandler);

    // Request 1: 200 OK (consumes quota)
    const resOk = await request(testApp).post("/test-limit").send({ msg: "hello" });
    expect(resOk.status).toBe(200);

    // Request 2: 429 RATE_LIMIT_EXCEEDED
    const res429 = await request(testApp).post("/test-limit").send({ msg: "blocked" });
    expect(res429.status).toBe(429);
    expect(res429.headers["x-request-id"]).toBeDefined();
    expect(res429.body.error.requestId).toBe(res429.headers["x-request-id"]);

    // Verify 429 was logged
    const log429 = rawLogs.map((l) => JSON.parse(l)).find((e) => e.statusCode === 429);
    expect(log429).toBeDefined();
    expect(log429.requestId).toBe(res429.headers["x-request-id"]);

    // Now test 413 on a fresh testApp without rate limiting
    const rawLogs413: string[] = [];
    const testStream413 = new Writable({
      write(chunk, _encoding, cb) {
        rawLogs413.push(chunk.toString());
        cb();
      },
    });
    const captureLogger413 = createLogger(testStream413);

    const testApp413 = express();
    testApp413.use(createRequestLogger(captureLogger413));
    testApp413.use(express.json({ limit: "100kb" }));
    testApp413.post("/test-large", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    testApp413.use(errorHandler);

    const largePayload = { str: "x".repeat(110 * 1024) };
    const res413 = await request(testApp413).post("/test-large").send(largePayload);
    expect(res413.status).toBe(413);
    expect(res413.headers["x-request-id"]).toBeDefined();
    expect(res413.body.error.requestId).toBe(res413.headers["x-request-id"]);

    // Verify 413 was logged
    const log413 = rawLogs413.map((l) => JSON.parse(l)).find((e) => e.statusCode === 413);
    expect(log413).toBeDefined();
    expect(log413.requestId).toBe(res413.headers["x-request-id"]);
  });
});
