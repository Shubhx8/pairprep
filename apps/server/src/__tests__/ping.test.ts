import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../index.js";
import { PingResponseSchema } from "@pairprep/shared";

describe("Server HTTP Endpoints", () => {
  it("GET / returns 200 with smoke greeting", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("Hello from PairPrep Backend!");
  });

  it("GET /api/ping returns 200 and matches PingResponseSchema", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);

    // Validate the response body against shared Zod schema
    const parseResult = PingResponseSchema.safeParse(res.body);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.status).toBe("ok");
      expect(parseResult.data.message).toContain("PairPrep backend");
      expect(new Date(parseResult.data.timestamp).getTime()).not.toBeNaN();
    }
  });

  it("GET /unknown-route returns 404", async () => {
    const res = await request(app).get("/not-found-xyz");
    expect(res.status).toBe(404);
  });
});
