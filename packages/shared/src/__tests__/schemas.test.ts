import { describe, it, expect } from "vitest";
import {
  PingResponseSchema,
  HealthResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
  RoomSchema,
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
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
        uptimeSec: 124.5,
        version: "0.1.0",
      };

      const result = HealthResponseSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("ok");
        expect(result.data.uptimeSec).toBeGreaterThanOrEqual(0);
        expect(result.data.version).toBe("0.1.0");
      }
    });

    it("rejects negative uptimeSec or invalid status", () => {
      expect(
        HealthResponseSchema.safeParse({
          status: "healthy", // not ok/degraded/down
          uptimeSec: 10,
          version: "0.1.0",
        }).success
      ).toBe(false);

      expect(
        HealthResponseSchema.safeParse({
          status: "ok",
          uptimeSec: -5,
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

  describe("Room & Member Schemas", () => {
    it("validates valid room and enforces 128-bit slug and max 6 participants", () => {
      const validRoom = {
        id: "room-uuid-1",
        slug: "a1b2c3d4e5f678901234567890abcdef",
        title: "Algorithms Practice",
        type: "practice",
        language: "python",
        status: "open",
        ownerId: "user-owner-1",
        members: [
          {
            id: "user-owner-1",
            displayName: "Aarav",
            role: "owner",
            color: "#3B82F6",
            isGuest: false,
            joinedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
      };

      const result = RoomSchema.safeParse(validRoom);
      expect(result.success).toBe(true);
    });

    it("rejects short slugs (less than 16 chars/128 bits)", () => {
      const roomWithShortSlug = {
        id: "room-uuid-1",
        slug: "short-slug",
        title: "Test",
        type: "practice",
        language: "python",
        status: "open",
        ownerId: "user-owner-1",
        members: [],
        createdAt: new Date().toISOString(),
      };

      expect(RoomSchema.safeParse(roomWithShortSlug).success).toBe(false);
    });

    it("enforces PRD ROOM-4 max 6 participants cap", () => {
      const members = Array.from({ length: 7 }, (_, i) => ({
        id: `user-${i}`,
        displayName: `User ${i}`,
        role: "editor",
        color: "#3B82F6",
        isGuest: true,
        joinedAt: new Date().toISOString(),
      }));

      const roomWith7Members = {
        id: "room-uuid-1",
        slug: "a1b2c3d4e5f678901234567890abcdef",
        title: "Test Full Room",
        type: "practice",
        language: "python",
        status: "open",
        ownerId: "user-owner-1",
        members,
        createdAt: new Date().toISOString(),
      };

      expect(RoomSchema.safeParse(roomWith7Members).success).toBe(false);
    });

    it("validates CreateRoomRequestSchema defaults", () => {
      const parsed = CreateRoomRequestSchema.parse({
        title: "Dynamic Programming Session",
      });
      expect(parsed.type).toBe("practice");
      expect(parsed.language).toBe("python");
      expect(parsed.ownerName).toBe("Anonymous Host");
    });

    it("rejects invalid JoinRoomRequestSchema", () => {
      expect(JoinRoomRequestSchema.safeParse({ displayName: "" }).success).toBe(false);
      expect(
        JoinRoomRequestSchema.safeParse({ displayName: "A".repeat(33) }).success
      ).toBe(false);
    });
  });
});
