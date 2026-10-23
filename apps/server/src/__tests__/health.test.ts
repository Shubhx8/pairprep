import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../index.js";
import { HealthResponseSchema } from "@pairprep/shared";

describe("Healthz & Observability Endpoint (OBS-4 & T01/T03)", () => {
  it("healthz: returns 200 with status, uptimeSec, version, and db status", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.headers["x-request-id"]).toBeDefined();

    // Verify fields required by PRD & T01/T03
    expect(res.body.status).toBe("ok");
    expect(res.body.uptimeSec).toBeDefined();
    expect(typeof res.body.uptimeSec).toBe("number");
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(res.body.version).toBe("0.1.0");
    expect(["ok", "down"]).toContain(res.body.db);

    const parseResult = HealthResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
  });

  // T03 CRITICAL FIX: /healthz must NEVER set a session cookie or create guest records
  it("healthz: does not set session cookie or Set-Cookie header on requests", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    // Explicitly assert that no Set-Cookie header exists on health checks
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("healthz: reports db as ok when mongodb is connected", async () => {
    // Mock readyState as 1 (connected)
    const spy = vi
      .spyOn(mongoose.connection, "readyState", "get")
      .mockReturnValue(1 as unknown as mongoose.ConnectionStates);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("ok");
    spy.mockRestore();
  });

  it("healthz: reports db as down without error details or credentials when disconnected", async () => {
    // Mock readyState as 0 (disconnected)
    const spy = vi
      .spyOn(mongoose.connection, "readyState", "get")
      .mockReturnValue(0 as unknown as mongoose.ConnectionStates);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.db).toBe("down");
    // Ensure no connection details, credentials, or stack traces are leaked
    expect(res.text).not.toMatch(/mongodb/i);
    expect(res.text).not.toMatch(/password/i);
    spy.mockRestore();
  });

  it("attaches unique X-Request-Id header to incoming requests", async () => {
    const res1 = await request(app).get("/healthz");
    const res2 = await request(app).get("/healthz");

    expect(res1.headers["x-request-id"]).toBeDefined();
    expect(res2.headers["x-request-id"]).toBeDefined();
    expect(res1.headers["x-request-id"]).not.toBe(res2.headers["x-request-id"]);
  });

  it("preserves incoming X-Request-Id header if provided as a valid UUID", async () => {
    const validUuid = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
    const res = await request(app).get("/healthz").set("X-Request-Id", validUuid);

    expect(res.headers["x-request-id"]).toBe(validUuid);
  });
});
