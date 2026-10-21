import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";
import { HealthResponseSchema } from "@pairprep/shared";

describe("Healthz & Observability Endpoint (OBS-4)", () => {
  it("GET /healthz returns 200 and matches HealthResponseSchema", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.headers["x-request-id"]).toBeDefined();

    const parseResult = HealthResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.status).toBe("ok");
      expect(parseResult.data.uptime).toBeGreaterThanOrEqual(0);
      expect(parseResult.data.version).toBe("0.1.0");
      expect(new Date(parseResult.data.timestamp).getTime()).not.toBeNaN();
    }
  });

  it("attaches unique X-Request-Id header to incoming requests", async () => {
    const res1 = await request(app).get("/healthz");
    const res2 = await request(app).get("/healthz");

    expect(res1.headers["x-request-id"]).toBeDefined();
    expect(res2.headers["x-request-id"]).toBeDefined();
    expect(res1.headers["x-request-id"]).not.toBe(res2.headers["x-request-id"]);
  });

  it("preserves incoming X-Request-Id header if provided by client or proxy", async () => {
    const customId = "client-trace-12345";
    const res = await request(app).get("/healthz").set("X-Request-Id", customId);

    expect(res.headers["x-request-id"]).toBe(customId);
  });
});
