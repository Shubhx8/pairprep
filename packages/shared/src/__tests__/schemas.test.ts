import { describe, it, expect } from "vitest";
import {
  PingResponseSchema,
  HealthResponseSchema,
  UserRoleSchema,
  SupportedLanguageSchema,
  RoomSchema,
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  toUserPublicDto,
  UserPublicDtoSchema,
  toUserPrivateDto,
  UserPrivateDtoSchema,
  UpdateProfileDtoSchema,
  sanitizeDisplayName,
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

  describe("User DTOs & Runtime Stripping (T04 Part 2)", () => {
    it("proves toUserPublicDto strictly strips email at runtime", () => {
      const privateUserObject = {
        id: "usr_12345",
        displayName: "Alice Developer",
        avatarUrl: "https://example.com/avatar.png",
        email: "alice@confidential.com",
        role: "user" as const,
        createdAt: new Date().toISOString(),
      };

      const publicDto = toUserPublicDto(privateUserObject);

      // Verify public properties exist
      expect(publicDto.id).toBe("usr_12345");
      expect(publicDto.displayName).toBe("Alice Developer");
      expect(publicDto.avatarUrl).toBe("https://example.com/avatar.png");
      expect(publicDto.role).toBe("user");

      // Verify email is completely stripped and never crosses boundary
      expect("email" in publicDto).toBe(false);
      expect((publicDto as unknown as Record<string, unknown>).email).toBeUndefined();
    });

    it("UserPublicDtoSchema rejects objects with extraneous fields under strict mode", () => {
      const objectWithEmail = {
        id: "usr_12345",
        displayName: "Alice Developer",
        role: "user",
        createdAt: new Date().toISOString(),
        email: "leak@example.com",
      };

      const result = UserPublicDtoSchema.safeParse(objectWithEmail);
      expect(result.success).toBe(false);
    });

    it("UpdateProfileDtoSchema rejects unrecognized fields under strict mode", () => {
      const invalid = {
        displayName: "Clean Name",
        role: "admin", // Unrecognized field
      };

      const result = UpdateProfileDtoSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("UpdateProfileDtoSchema rejects avatarUrl (display name only, AUTH-5)", () => {
      const withAvatar = {
        displayName: "Clean Name",
        avatarUrl: "https://example.com/avatar.jpg",
      };

      const result = UpdateProfileDtoSchema.safeParse(withAvatar);
      expect(result.success).toBe(false);
    });

    it("proves toUserPrivateDto asserts exact key set and excludes providerId, disabled, lastLoginAt, _id, __v", () => {
      const fullMongooseUserLike = {
        _id: "661234567890abcdef123456",
        __v: 0,
        id: "usr_full_123",
        provider: "github" as const,
        providerId: "gh_987654321",
        displayName: "Bob Developer",
        email: "bob@example.com",
        avatarUrl: "https://github.com/avatar.png",
        role: "user" as const,
        disabled: false,
        lastLoginAt: new Date(),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      // With avatarUrl
      const dtoWithAvatar = toUserPrivateDto(fullMongooseUserLike);
      expect(Object.keys(dtoWithAvatar).sort()).toEqual([
        "avatarUrl",
        "createdAt",
        "displayName",
        "email",
        "id",
        "provider",
        "role",
      ]);
      expect("providerId" in dtoWithAvatar).toBe(false);
      expect("disabled" in dtoWithAvatar).toBe(false);
      expect("lastLoginAt" in dtoWithAvatar).toBe(false);
      expect("_id" in dtoWithAvatar).toBe(false);
      expect("__v" in dtoWithAvatar).toBe(false);

      // Without avatarUrl (avatarUrl must be absent from keys)
      const userWithoutAvatar = {
        ...fullMongooseUserLike,
        avatarUrl: undefined,
      };
      const dtoWithoutAvatar = toUserPrivateDto(userWithoutAvatar);
      expect(Object.keys(dtoWithoutAvatar).sort()).toEqual([
        "createdAt",
        "displayName",
        "email",
        "id",
        "provider",
        "role",
      ]);
      expect("avatarUrl" in dtoWithoutAvatar).toBe(false);
    });

    it("proves toUserPublicDto asserts exact key set and excludes email, providerId, disabled, lastLoginAt, _id, __v", () => {
      const fullMongooseUserLike = {
        _id: "661234567890abcdef123456",
        __v: 0,
        id: "usr_full_456",
        provider: "google" as const,
        providerId: "google_123456",
        displayName: "Charlie Developer",
        email: "charlie@example.com",
        avatarUrl: "https://lh3.googleusercontent.com/avatar.png",
        role: "user" as const,
        disabled: false,
        lastLoginAt: new Date(),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      // With avatarUrl
      const dtoWithAvatar = toUserPublicDto(fullMongooseUserLike);
      expect(Object.keys(dtoWithAvatar).sort()).toEqual([
        "avatarUrl",
        "createdAt",
        "displayName",
        "id",
        "role",
      ]);
      expect("email" in dtoWithAvatar).toBe(false);
      expect("provider" in dtoWithAvatar).toBe(false);
      expect("providerId" in dtoWithAvatar).toBe(false);
      expect("disabled" in dtoWithAvatar).toBe(false);
      expect("lastLoginAt" in dtoWithAvatar).toBe(false);
      expect("_id" in dtoWithAvatar).toBe(false);
      expect("__v" in dtoWithAvatar).toBe(false);

      // Without avatarUrl
      const userWithoutAvatar = {
        ...fullMongooseUserLike,
        avatarUrl: undefined,
      };
      const dtoWithoutAvatar = toUserPublicDto(userWithoutAvatar);
      expect(Object.keys(dtoWithoutAvatar).sort()).toEqual([
        "createdAt",
        "displayName",
        "id",
        "role",
      ]);
      expect("avatarUrl" in dtoWithoutAvatar).toBe(false);
    });

    it("UserPrivateDtoSchema rejects objects with extraneous fields under strict mode", () => {
      const objectWithExtraneous = {
        id: "usr_12345",
        provider: "google",
        displayName: "Alice Developer",
        email: "alice@example.com",
        role: "user",
        createdAt: new Date().toISOString(),
        providerId: "leak_provider_id",
      };

      const result = UserPrivateDtoSchema.safeParse(objectWithExtraneous);
      expect(result.success).toBe(false);
    });

    it("sanitizeDisplayName strips \\p{Cc} and \\p{Cf} characters and normalizes NFC", () => {
      // Includes null byte (\u0000), backspace (\u0008), zero-width non-joiner (\u200C - Cf)
      const dirty = "  User\u0000Name\u200C  ";
      const cleaned = sanitizeDisplayName(dirty);
      expect(cleaned).toBe("UserName");
    });
  });
});
