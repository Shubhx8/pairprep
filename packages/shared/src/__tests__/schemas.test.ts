import { describe, it, expect } from "vitest";
import {
  PingResponseSchema,
  HealthResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
} from "../index.js";

describe("Shared Zod Schemas", () => {
  describe("PingResponseSchema", () => {
    it("validates a compliant ping response payload", () => {
      const validPayload = {
        status: "ok",
        message: "PairPrep backend wired",
        timestamp: new Date().toISOString(),
        environment: "development",
      };

      const result = PingResponseSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("ok");
        expect(result.data.environment).toBe("development");
      }
    });

    it("rejects payload with invalid status or environment", () => {
      const invalidPayload = {
        status: "error",
        message: "failed",
        timestamp: new Date().toISOString(),
        environment: "staging",
      };

      const result = PingResponseSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it("rejects payload missing required fields", () => {
      const incomplete = {
        status: "ok",
      };

      const result = PingResponseSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
    });
  });

  describe("HealthResponseSchema (OBS-4)", () => {
    it("validates a compliant health response payload", () => {
      const payload = {
        status: "ok",
        uptime: 124.5,
        timestamp: new Date().toISOString(),
        version: "0.1.0",
      };

      const result = HealthResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("ok");
        expect(result.data.uptime).toBeGreaterThanOrEqual(0);
      }
    });

    it("rejects negative uptime or invalid status", () => {
      expect(
        HealthResponseSchema.safeParse({
          status: "healthy", // not ok/degraded/down
          uptime: 10,
          timestamp: new Date().toISOString(),
          version: "0.1.0",
        }).success
      ).toBe(false);

      expect(
        HealthResponseSchema.safeParse({
          status: "ok",
          uptime: -5,
          timestamp: new Date().toISOString(),
          version: "0.1.0",
        }).success
      ).toBe(false);
    });
  });

  describe("UserRoleSchema", () => {
    it("accepts all defined PRD 6.2 roles", () => {
      const validRoles = ["owner", "interviewer", "candidate", "editor", "viewer"];
      for (const role of validRoles) {
        expect(UserRoleSchema.safeParse(role).success).toBe(true);
      }
    });

    it("rejects unauthorized or arbitrary roles", () => {
      expect(UserRoleSchema.safeParse("superadmin").success).toBe(false);
      expect(UserRoleSchema.safeParse("hacker").success).toBe(false);
      expect(UserRoleSchema.safeParse("").success).toBe(false);
    });
  });

  describe("SupportedLanguageSchema", () => {
    it("accepts supported sandbox languages (python, cpp, javascript)", () => {
      expect(SupportedLanguageSchema.safeParse("python").success).toBe(true);
      expect(SupportedLanguageSchema.safeParse("cpp").success).toBe(true);
      expect(SupportedLanguageSchema.safeParse("javascript").success).toBe(true);
    });

    it("rejects unsupported languages", () => {
      expect(SupportedLanguageSchema.safeParse("java").success).toBe(false);
      expect(SupportedLanguageSchema.safeParse("rust").success).toBe(false);
    });
  });
});
