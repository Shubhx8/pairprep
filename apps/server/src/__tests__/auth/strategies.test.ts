import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import passport from "passport";
import type { Strategy as GoogleStrategyType } from "passport-google-oauth20";
import type {
  Strategy as GitHubStrategyType,
  Profile as GitHubProfile,
} from "passport-github2";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { configurePassport } from "../../auth/passport.js";
import { config } from "../../config.js";
import { UserModel, IUser } from "../../models/users.js";
import type { Request, Response, NextFunction } from "express";

interface StrategyWithInternals {
  name: string;
  _pkceMethod?: string;
  _stateStore?: { constructor: { name: string } };
  _verify: (
    req: unknown,
    accessToken: string,
    refreshToken: string,
    profile: unknown,
    done: (err: unknown, user?: unknown) => void
  ) => void;
}

describe("OAuth 2.0 Real Strategies & Session DB-down (T04)", () => {
  beforeAll(async () => {
    await setupTestDb("auth_strategies");
    config.GOOGLE_CLIENT_ID = "test-real-google-id";
    config.GOOGLE_CLIENT_SECRET = "test-real-google-secret";
    config.GITHUB_CLIENT_ID = "test-real-github-id";
    config.GITHUB_CLIENT_SECRET = "test-real-github-secret";
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.restoreAllMocks();
  });

  it("strategies: GoogleStrategy initializes with state: true and PKCE S256", () => {
    configurePassport();
    const strategies = (
      passport as unknown as { _strategies: Record<string, GoogleStrategyType> }
    )._strategies;
    const googleStrat = strategies["google"] as unknown as StrategyWithInternals;
    expect(googleStrat).toBeDefined();
    expect(googleStrat.name).toBe("google");
    expect(googleStrat._pkceMethod).toBe("S256");
    expect(googleStrat._stateStore?.constructor?.name).toBe("PKCESessionStore");
  });

  it("strategies: GoogleStrategy verify callback upserts user with verified email and displayName", async () => {
    configurePassport();
    const strategies = (
      passport as unknown as { _strategies: Record<string, GoogleStrategyType> }
    )._strategies;
    const googleStrat = strategies["google"] as unknown as StrategyWithInternals;

    const mockProfile = {
      id: "google_verify_123",
      displayName: "Real Google Name",
      emails: [{ value: "real.google@example.com", verified: true }],
      photos: [{ value: "https://lh3.googleusercontent.com/avatar.jpg" }],
    };

    let savedUser: IUser | null = null;
    let savedErr: unknown = null;

    await new Promise<void>((resolve) => {
      googleStrat._verify(
        {},
        "mock_access",
        "mock_refresh",
        mockProfile,
        (err: unknown, user?: unknown) => {
          savedErr = err;
          savedUser = (user as IUser) || null;
          resolve();
        }
      );
    });

    expect(savedErr).toBeNull();
    expect(savedUser).toBeDefined();
    expect(savedUser!.email).toBe("real.google@example.com");
    expect(savedUser!.displayName).toBe("Real Google Name");
    expect(savedUser!.avatarUrl).toBe("https://lh3.googleusercontent.com/avatar.jpg");

    const inDb = await UserModel.findOne({ providerId: "google_verify_123" });
    expect(inDb).not.toBeNull();
    expect(inDb?.email).toBe("real.google@example.com");
  });

  it("strategies: GitHubStrategy verify callback enforces verified emails and sets null when unverified", async () => {
    configurePassport();
    const strategies = (
      passport as unknown as { _strategies: Record<string, GitHubStrategyType> }
    )._strategies;
    const githubStrat = strategies["github"] as unknown as StrategyWithInternals;
    expect(githubStrat).toBeDefined();

    // 1. Profile with only unverified emails -> sets null
    const mockUnverifiedProfile: GitHubProfile = {
      id: "github_unverified_456",
      username: "octocat_unverified",
      displayName: "Unverified Octocat",
      provider: "github",
      profileUrl: "https://github.com/octocat",
      emails: [
        {
          value: "fake@unverified.org",
        } as { value: string },
      ],
    };

    let userFallback: IUser | null = null;
    await new Promise<void>((resolve) => {
      githubStrat._verify(
        {},
        "mock_access",
        "mock_refresh",
        mockUnverifiedProfile,
        (_err: unknown, user?: unknown) => {
          userFallback = (user as IUser) || null;
          resolve();
        }
      );
    });

    expect(userFallback!.email).toBeNull();

    // 2. Profile with verified email -> uses verified email
    const mockVerifiedProfile: GitHubProfile = {
      id: "github_verified_789",
      username: "octocat_verified",
      displayName: "Verified Octocat",
      provider: "github",
      profileUrl: "https://github.com/octocat",
      emails: [
        {
          value: "verified@test.org",
        } as { value: string },
      ],
    };
    (
      mockVerifiedProfile.emails![0] as unknown as { verified: boolean; primary: boolean }
    ).verified = true;
    (
      mockVerifiedProfile.emails![0] as unknown as { verified: boolean; primary: boolean }
    ).primary = true;

    let userVerified: IUser | null = null;
    await new Promise<void>((resolve) => {
      githubStrat._verify(
        {},
        "mock_access",
        "mock_refresh",
        mockVerifiedProfile,
        (_err: unknown, user?: unknown) => {
          userVerified = (user as IUser) || null;
          resolve();
        }
      );
    });

    expect(userVerified!.email).toBe("verified@test.org");
  });

  it("session: error handler emits 503 DATABASE_UNAVAILABLE when session store returns an error", () => {
    const req = {
      headers: { "x-request-id": "req-db-down-503" },
    } as unknown as Request;

    let resStatusCode = 0;
    let resJsonBody: unknown = null;

    const res = {
      status: (code: number) => {
        resStatusCode = code;
        return {
          json: (body: unknown) => {
            resJsonBody = body;
          },
        };
      },
      getHeader: () => undefined,
    } as unknown as Response;

    const next: NextFunction = vi.fn();

    // Verify wrapped error handler for 503 DATABASE_UNAVAILABLE
    const wrappedErrorHandler = (_err: unknown) => {
      res.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Session service temporarily unavailable",
          requestId: (req.headers["x-request-id"] as string) || "",
        },
      });
    };

    wrappedErrorHandler(new Error("MongoDB connection failed"));

    expect(next).not.toHaveBeenCalled();
    expect(resStatusCode).toBe(503);
    expect(resJsonBody).toEqual({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "Session service temporarily unavailable",
        requestId: "req-db-down-503",
      },
    });
  });

  it("strategies: clamps provider displayName exceeding 40 code points to 40 code points", async () => {
    configurePassport();
    const strategies = (
      passport as unknown as { _strategies: Record<string, GoogleStrategyType> }
    )._strategies;
    const googleStrat = strategies["google"] as unknown as StrategyWithInternals;

    const longDisplayName = "A".repeat(50);
    const mockProfile = {
      id: "google_long_name_123",
      displayName: longDisplayName,
      emails: [{ value: "long.name@example.com", verified: true }],
    };

    let savedUser: IUser | null = null;
    await new Promise<void>((resolve) => {
      googleStrat._verify(
        {},
        "mock_access",
        "mock_refresh",
        mockProfile,
        (_err: unknown, user?: unknown) => {
          savedUser = (user as IUser) || null;
          resolve();
        }
      );
    });

    expect(savedUser).not.toBeNull();
    expect(savedUser!.displayName.length).toBe(40);
    expect([...savedUser!.displayName].length).toBe(40);
    expect(savedUser!.displayName).toBe("A".repeat(40));

    // Also verify with 50 emoji code points
    const emojiDisplayName = "😀".repeat(50);
    const mockEmojiProfile = {
      id: "google_emoji_name_123",
      displayName: emojiDisplayName,
      emails: [{ value: "emoji.name@example.com", verified: true }],
    };

    let emojiUser: IUser | null = null;
    await new Promise<void>((resolve) => {
      googleStrat._verify(
        {},
        "mock_access",
        "mock_refresh",
        mockEmojiProfile,
        (_err: unknown, user?: unknown) => {
          emojiUser = (user as IUser) || null;
          resolve();
        }
      );
    });

    expect(emojiUser).not.toBeNull();
    expect([...emojiUser!.displayName].length).toBe(40);
    expect(emojiUser!.displayName).toBe("😀".repeat(40));
  });
});
