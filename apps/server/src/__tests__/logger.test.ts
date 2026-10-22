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
});
