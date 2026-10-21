import { describe, it, expect } from "vitest";
import {
  PingResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
} from "@pairprep/shared";

describe("Frontend Client Contracts & State Utilities", () => {
  it("parses valid server response for frontend display", () => {
    const mockServerData = {
      status: "ok",
      message: "Test message",
      timestamp: "2026-10-21T14:00:00.000Z",
      environment: "development",
    };

    const parse = PingResponseSchema.safeParse(mockServerData);
    expect(parse.success).toBe(true);
  });

  it("identifies corrupted server payloads to prevent UI crashes", () => {
    const corruptedData = {
      status: "invalid_status",
      message: null,
    };

    const parse = PingResponseSchema.safeParse(corruptedData);
    expect(parse.success).toBe(false);
  });

  it("exposes all required roles for the client UI", () => {
    expect(UserRoleSchema.options).toContain("owner");
    expect(UserRoleSchema.options).toContain("interviewer");
    expect(UserRoleSchema.options).toContain("candidate");
  });

  it("exposes all supported execution languages for the editor selector", () => {
    expect(SupportedLanguageSchema.options).toEqual(["python", "cpp", "javascript"]);
  });
});
