import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { z } from "zod";
import app from "../index.js";
import { AppError } from "../errors/AppError.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { ApiErrorResponseSchema } from "@pairprep/shared";

describe("Unified Error Handling (T01)", () => {
  it("errors: GET /non-existent-route returns 404 with standard error shape and requestId", async () => {
    const res = await request(app).get("/route-that-definitely-does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);

    const parsed = ApiErrorResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe("NOT_FOUND");
      expect(parsed.data.error.message).toContain("Cannot GET");
      expect(parsed.data.error.requestId).toBeDefined();
    }
    expect(res.body.stack).toBeUndefined();
    expect(res.body.error.stack).toBeUndefined();
  });

  it("errors: validation failure returns 400 with VALIDATION_ERROR code, field names, and no stack trace", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.post("/validate", (req, _res, next) => {
      try {
        const schema = z.object({ title: z.string().min(1, "Title is required") });
        schema.parse(req.body);
      } catch (err) {
        next(err);
      }
    });
    testApp.use(errorHandler);

    const res = await request(testApp).post("/validate").send({ title: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.fields).toBeDefined();
    expect(res.body.error.fields.title).toBeDefined();

    expect(res.body.stack).toBeUndefined();
    expect(res.body.error.stack).toBeUndefined();
  });

  it("errors: oversized JSON returns 413 with code PAYLOAD_TOO_LARGE and standard error shape", async () => {
    const testApp = express();
    // Test with explicit 100kb limit
    testApp.use(express.json({ limit: "100kb" }));
    testApp.post("/upload", (_req, res) => {
      res.status(200).send("ok");
    });
    testApp.use(errorHandler);

    // Payload exceeding 100 KB
    const largePayload = { data: "x".repeat(110 * 1024) };

    const res = await request(testApp).post("/upload").send(largePayload);

    expect(res.status).toBe(413);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.error.message).toContain("100 KB");
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.stack).toBeUndefined();
    expect(res.body.error.stack).toBeUndefined();
  });

  it("errors: malformed JSON returns 400 with code INVALID_JSON and standard error shape", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.post("/test-json", (_req, res) => {
      res.status(200).send("ok");
    });
    testApp.use(errorHandler);

    // Send broken JSON string
    const res = await request(testApp)
      .post("/test-json")
      .set("Content-Type", "application/json")
      .send("{ invalid json string missing quotes }");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("INVALID_JSON");
    expect(res.body.error.message).toContain("Malformed JSON");
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.stack).toBeUndefined();
    expect(res.body.error.stack).toBeUndefined();
  });

  it("errors: AppError correctly sets custom status code and stable error code", () => {
    const err = new AppError("Forbidden action", 403, "FORBIDDEN_CUSTOM", {
      reason: "Not allowed",
    });
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN_CUSTOM");
    expect(err.message).toBe("Forbidden action");
    expect(err.fields).toEqual({ reason: "Not allowed" });
    expect(err.name).toBe("AppError");
  });
});
