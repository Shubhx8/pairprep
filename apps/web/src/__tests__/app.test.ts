import { describe, it, expect } from "vitest";
import {
  HealthResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
} from "@pairprep/shared";

describe("Frontend Client Contracts & One-Origin State (T02)", () => {
  it("ui: parses valid /healthz response for frontend placeholder display", () => {
    const mockHealthData = {
      status: "ok",
      uptimeSec: 42.15,
      version: "0.1.0",
    };

    const parse = HealthResponseSchema.safeParse(mockHealthData);
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.status).toBe("ok");
      expect(parse.data.uptimeSec).toBe(42.15);
      expect(parse.data.version).toBe("0.1.0");
    }
  });

  it("ui: rejects corrupted health response preventing UI state crashes", () => {
    const corruptedData = {
      status: "invalid_status",
      uptimeSec: "not-a-number",
    };

    const parse = HealthResponseSchema.safeParse(corruptedData);
    expect(parse.success).toBe(false);
  });

  it("ui: accepts optional legacy timestamp if returned by healthcheck", () => {
    const healthWithTimestamp = {
      status: "ok",
      uptimeSec: 100.5,
      version: "0.1.0",
      timestamp: "2026-10-22T22:00:00.000Z",
    };

    const parse = HealthResponseSchema.safeParse(healthWithTimestamp);
    expect(parse.success).toBe(true);
  });

  it("shared contracts: exposes all required roles for the client UI", () => {
    expect(UserRoleSchema.options).toContain("owner");
    expect(UserRoleSchema.options).toContain("interviewer");
    expect(UserRoleSchema.options).toContain("candidate");
    expect(UserRoleSchema.options).toContain("editor");
    expect(UserRoleSchema.options).toContain("viewer");
  });

  it("shared contracts: exposes all supported execution languages for the editor selector", () => {
    expect(SupportedLanguageSchema.options).toEqual(["python", "cpp", "javascript"]);
  });
});
