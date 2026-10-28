import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { UserModel } from "../../models/users.js";
import { toUserPrivateDto, UserPublicDtoSchema } from "@pairprep/shared";

describe("User Model & Repository (PRD 12, AUTH-1, AUTH-2, AUTH-5)", () => {
  beforeAll(async () => {
    await setupTestDb("users");
  }, 15000);

  beforeEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("users: rejects duplicate user with identical provider and providerId", async () => {
    await userRepo.upsertUser({
      provider: "google",
      providerId: "google-uid-12345",
      displayName: "Jane Developer",
      email: "jane@example.com",
    });

    // Directly attempting to insert a second document with duplicate compound key must fail
    const duplicateDoc = new UserModel({
      provider: "google",
      providerId: "google-uid-12345",
      displayName: "Jane Impostor",
      email: "jane.impostor@example.com",
    });

    await expect(duplicateDoc.save()).rejects.toThrow(/E11000 duplicate key error/);
  });

  it("users: UserPublicDto excludes email while UserPrivateDto includes email", async () => {
    const user = await userRepo.upsertUser({
      provider: "github",
      providerId: "gh-98765",
      displayName: "Alex Coder",
      avatarUrl: "https://example.com/avatar.png",
      email: "alex@secret-domain.com",
      role: "user",
    });

    // UserPrivateDto must include email and pass validation
    const privateDto = toUserPrivateDto(user);
    expect(privateDto.email).toBe("alex@secret-domain.com");

    // UserPublicDto must validate without email
    const publicDto = UserPublicDtoSchema.parse({
      id: user._id.toString(),
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    });
    // Explicitly verify email is not in public DTO
    expect((publicDto as unknown as { email?: string }).email).toBeUndefined();
  });

  it("users: upsertUser preserves display name and avatarUrl on subsequent logins without modifying createdAt", async () => {
    const user1 = await userRepo.upsertUser({
      provider: "google",
      providerId: "google-uid-update",
      displayName: "Initial Name",
      avatarUrl: "https://example.com/initial-avatar.png",
      email: "user@example.com",
    });

    const initialCreated = user1.createdAt.getTime();

    const user2 = await userRepo.upsertUser({
      provider: "google",
      providerId: "google-uid-update",
      displayName: "Updated Name",
      avatarUrl: "https://example.com/new-avatar.png",
      email: "user-new@example.com",
    });

    expect(user2.displayName).toBe("Initial Name");
    expect(user2.avatarUrl).toBe("https://example.com/initial-avatar.png");
    expect(user2.email).toBe("user-new@example.com");
    expect(user2.createdAt.getTime()).toBe(initialCreated);
  });

  it("users: upsertUser preserves existing email when subsequent login provides null or undefined email", async () => {
    await userRepo.upsertUser({
      provider: "github",
      providerId: "gh-null-email",
      displayName: "GitHub Dev",
      email: "original@example.com",
    });

    // Login again where OAuth provider returns undefined/null email (e.g. private email)
    const userWithoutEmail = await userRepo.upsertUser({
      provider: "github",
      providerId: "gh-null-email",
      displayName: "GitHub Dev",
      email: undefined,
    });

    expect(userWithoutEmail.email).toBe("original@example.com");

    const userWithNullEmail = await userRepo.upsertUser({
      provider: "github",
      providerId: "gh-null-email",
      displayName: "GitHub Dev",
      email: null,
    });

    expect(userWithNullEmail.email).toBe("original@example.com");
  });
});
