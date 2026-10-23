import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, clearTestDb } from "./testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { UserModel } from "../../models/users.js";
import { UserPrivateDtoSchema, UserPublicDtoSchema } from "@pairprep/shared";

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
    const privateDto = UserPrivateDtoSchema.parse({
      id: user._id.toString(),
      provider: user.provider,
      providerId: user.providerId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      disabled: user.disabled,
    });
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

  it("users: upsertUser updates display name and avatarUrl without modifying createdAt", async () => {
    const user1 = await userRepo.upsertUser({
      provider: "google",
      providerId: "google-uid-update",
      displayName: "Initial Name",
      email: "user@example.com",
    });

    const initialCreated = user1.createdAt.getTime();

    const user2 = await userRepo.upsertUser({
      provider: "google",
      providerId: "google-uid-update",
      displayName: "Updated Name",
      avatarUrl: "https://example.com/new-avatar.png",
      email: "user@example.com",
    });

    expect(user2.displayName).toBe("Updated Name");
    expect(user2.avatarUrl).toBe("https://example.com/new-avatar.png");
    expect(user2.createdAt.getTime()).toBe(initialCreated);
  });
});
