import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";
import { HealthResponseSchema } from "@pairprep/shared";

describe("Healthz & Observability Endpoint (OBS-4 & T01)", () => {
  it("healthz: returns 200 with status, uptimeSec, and version matching schema", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.headers["x-request-id"]).toBeDefined();

    // Verify fields required by PRD & T01
    expect(res.body.status).toBe("ok");
    expect(res.body.uptimeSec).toBeDefined();
    expect(typeof res.body.uptimeSec).toBe("number");
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(res.body.version).toBe("0.1.0");

    const parseResult = HealthResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
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
