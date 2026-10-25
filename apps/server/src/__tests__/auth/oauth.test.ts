import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { userRepo } from "../../repos/userRepo.js";
import { passport, configurePassport } from "../../auth/passport.js";
import { config } from "../../config.js";
import { authRateLimiter } from "../../middleware/authRateLimiter.js";
import { UserModel } from "../../models/users.js";

interface StrategyWithInternals {
  _oauth2: {
    getOAuthAccessToken: (
      code: string,
      params: Record<string, unknown>,
      callback: (
        err: unknown,
        accessToken?: string,
        refreshToken?: string,
        results?: unknown
      ) => void
    ) => void;
  };
  userProfile: (
    accessToken: string,
    done: (err: unknown, profile?: unknown) => void
  ) => void;
}

describe("OAuth 2.0 Real Strategy Integration & PKCE (T04 / PRD 6.1 AUTH-1, AUTH-2 / 13.1)", () => {
  let googleStrategy: StrategyWithInternals;
  let githubStrategy: StrategyWithInternals;

  beforeAll(async () => {
    await setupTestDb("auth_oauth_real");
    config.GOOGLE_CLIENT_ID = "mock_google_client_id";
    config.GOOGLE_CLIENT_SECRET = "mock_google_client_secret";
    config.GITHUB_CLIENT_ID = "mock_github_client_id";
    config.GITHUB_CLIENT_SECRET = "mock_github_client_secret";
    config.SITE_ORIGIN = "http://localhost:3000";

    configurePassport();
    // Retrieve real strategy instances registered in passport
    const strategies = (
      passport as unknown as { _strategies: Record<string, StrategyWithInternals> }
    )._strategies;
    googleStrategy = strategies["google"]!;
    githubStrategy = strategies["github"]!;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.restoreAllMocks();
    authRateLimiter.resetKey("127.0.0.1");
    authRateLimiter.resetKey("::ffff:127.0.0.1");
    authRateLimiter.resetKey("::1");
  });

  describe("Initiation Redirects: Google (PKCE + state) & GitHub (state)", () => {
    it("auth: GET /auth/google initiates Google OAuth with code_challenge, S256, state, and Cache-Control: no-store", async () => {
      const res = await request(app).get("/api/v1/auth/google");

      expect(res.status).toBe(302);
      expect(res.headers["cache-control"]).toContain("no-store");
      const location = res.headers["location"];
      expect(location).toBeDefined();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin).toBe("https://accounts.google.com");
      expect(redirectUrl.pathname).toBe("/o/oauth2/v2/auth");
      expect(redirectUrl.searchParams.get("client_id")).toBe("mock_google_client_id");
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("scope")).toBe("profile email");

      // Verify PKCE & State
      const state = redirectUrl.searchParams.get("state");
      const codeChallenge = redirectUrl.searchParams.get("code_challenge");
      const codeChallengeMethod = redirectUrl.searchParams.get("code_challenge_method");

      expect(state).toBeTruthy();
      expect(codeChallenge).toBeTruthy();
      expect(codeChallengeMethod).toBe("S256");
    });

    it("auth: GET /auth/github initiates GitHub OAuth with state and without PKCE", async () => {
      const res = await request(app).get("/api/v1/auth/github");

      expect(res.status).toBe(302);
      const location = res.headers["location"];
      expect(location).toBeDefined();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin).toBe("https://github.com");
      expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
      expect(redirectUrl.searchParams.get("client_id")).toBe("mock_github_client_id");
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");

      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(redirectUrl.searchParams.get("code_challenge")).toBeNull();
    });
  });

  describe("Real Strategy Callback Flows & PKCE Verification", () => {
    it("auth: Google callback with matching state calls getOAuthAccessToken with code_verifier and creates session", async () => {
      const agent = request.agent(app);

      // 1. Initiate flow to generate state & code_verifier in session
      const initRes = await agent.get("/api/v1/auth/google");
      const location = new URL(initRes.headers["location"]!);
      const state = location.searchParams.get("state")!;

      let passedCodeVerifier = "";
      vi.spyOn(googleStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code: string, params: Record<string, unknown>, callback) => {
          passedCodeVerifier = (params["code_verifier"] as string) || "";
          callback(null, "mock_google_access_token", "mock_google_refresh_token", {});
        }
      );

      vi.spyOn(googleStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "google_uid_real_100",
          displayName: "Google Real User",
          emails: [{ value: "google.real@example.com", verified: true }],
          photos: [{ value: "https://lh3.googleusercontent.com/pic.png" }],
        });
      });

      // 2. Perform callback with matching state
      const callbackRes = await agent.get(
        `/api/v1/auth/callback/google?code=google_auth_code_xyz&state=${state}`
      );

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers["location"]).toBe("/");
      expect(passedCodeVerifier).toBeTruthy(); // Proves code_verifier was passed by PKCESessionStore!

      // 3. Verify user was upserted in MongoDB
      const dbUser = await UserModel.findOne({ providerId: "google_uid_real_100" });
      expect(dbUser).not.toBeNull();
      expect(dbUser?.displayName).toBe("Google Real User");
      expect(dbUser?.email).toBe("google.real@example.com");

      // 4. Verify access to protected /me endpoint with the established session
      const meRes = await agent.get("/api/v1/me");
      expect(meRes.status).toBe(200);
      expect(meRes.body.displayName).toBe("Google Real User");
      expect(meRes.body.email).toBe("google.real@example.com");
    });

    it("auth: GitHub callback with matching state completes login and creates session", async () => {
      const agent = request.agent(app);

      // 1. Initiate flow
      const initRes = await agent.get("/api/v1/auth/github");
      const location = new URL(initRes.headers["location"]!);
      const state = location.searchParams.get("state")!;

      vi.spyOn(githubStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code, _params, callback) => {
          callback(null, "mock_github_access_token", "mock_github_refresh_token", {});
        }
      );

      vi.spyOn(githubStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "github_uid_real_200",
          username: "octocat_coder",
          displayName: "Octocat Real Coder",
          emails: [{ value: "octocat@test.org", verified: true }],
          photos: [{ value: "https://avatars.githubusercontent.com/u/200" }],
        });
      });

      // 2. Callback
      const callbackRes = await agent.get(
        `/api/v1/auth/callback/github?code=github_auth_code_abc&state=${state}`
      );

      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers["location"]).toBe("/");

      const meRes = await agent.get("/api/v1/me");
      expect(meRes.status).toBe(200);
      expect(meRes.body.displayName).toBe("Octocat Real Coder");
      expect(meRes.body.email).toBe("octocat@test.org");
    });
  });

  describe("Negative OAuth Tests: State Mismatch, Missing State, Replay & Access Denied", () => {
    it("auth: callback redirects to /login?error=access_denied when error=access_denied is present", async () => {
      const res = await request(app).get(
        "/api/v1/auth/callback/google?error=access_denied"
      );
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=access_denied");
    });

    it("auth: callback redirects to /login?error=missing_state when state is missing", async () => {
      const res = await request(app).get("/api/v1/auth/callback/google?code=mock_code");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=missing_state");
    });

    it("auth: callback redirects to /login?error=missing_code when code is missing", async () => {
      const res = await request(app).get("/api/v1/auth/callback/google?state=mock_state");
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=missing_code");
    });

    it("auth: maps arbitrary errors to allowlist and never puts req.query.error or err.code into redirect", async () => {
      const resInjection = await request(app).get(
        "/api/v1/auth/callback/google?error=%3Cscript%3Ealert(1)%3C/script%3E&state=test_state"
      );
      expect(resInjection.status).toBe(302);
      expect(resInjection.headers["location"]).toBe("/login?error=auth_failed");
      expect(resInjection.headers["location"]).not.toContain("<script>");

      const resUnknown = await request(app).get(
        "/api/v1/auth/callback/google?error=server_error&state=test_state"
      );
      expect(resUnknown.status).toBe(302);
      expect(resUnknown.headers["location"]).toBe("/login?error=auth_failed");
    });

    it("auth: callback redirects to /login?error=auth_failed on mismatched state", async () => {
      const agent = request.agent(app);
      await agent.get("/api/v1/auth/google");

      const res = await agent.get(
        "/api/v1/auth/callback/google?code=mock_code&state=forged_untrusted_state"
      );
      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=auth_failed");
    });

    it("auth: callback rejects replayed state attacks with /login?error=auth_failed", async () => {
      const agent = request.agent(app);
      const initRes = await agent.get("/api/v1/auth/google");
      const location = new URL(initRes.headers["location"]!);
      const state = location.searchParams.get("state")!;

      vi.spyOn(googleStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code, _params, callback) => {
          callback(null, "token_1", "refresh_1", {});
        }
      );
      vi.spyOn(googleStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "google_replay_uid",
          displayName: "Replay Test",
          emails: [{ value: "replay@example.com", verified: true }],
        });
      });

      // First callback consumes the state
      const res1 = await agent.get(
        `/api/v1/auth/callback/google?code=code_1&state=${state}`
      );
      expect(res1.status).toBe(302);
      expect(res1.headers["location"]).toBe("/");

      // Second callback reusing the same state must fail because passport-oauth2 deleted the state
      const res2 = await agent.get(
        `/api/v1/auth/callback/google?code=code_2&state=${state}`
      );
      expect(res2.status).toBe(302);
      expect(res2.headers["location"]).toBe("/login?error=auth_failed");
    });

    it("auth: rejects disabled user in callback with redirect to /login?error=auth_failed", async () => {
      const agent = request.agent(app);
      const initRes = await agent.get("/api/v1/auth/google");
      const location = new URL(initRes.headers["location"]!);
      const state = location.searchParams.get("state")!;

      // Create an already disabled user in the database
      await UserModel.create({
        provider: "google",
        providerId: "google_disabled_uid_999",
        displayName: "Disabled Person",
        email: "disabled@example.com",
        disabled: true,
      });

      vi.spyOn(googleStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code, _params, callback) => {
          callback(null, "token_disabled", "refresh_disabled", {});
        }
      );
      vi.spyOn(googleStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "google_disabled_uid_999",
          displayName: "Disabled Person",
          emails: [{ value: "disabled@example.com", verified: true }],
        });
      });

      const callbackRes = await agent.get(
        `/api/v1/auth/callback/google?code=valid_code&state=${state}`
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers["location"]).toBe("/login?error=auth_failed");

      // Verify session was not created (accessing /me returns 401)
      const meRes = await agent.get("/api/v1/me");
      expect(meRes.status).toBe(401);
    });

    it("auth: returns 404 for non-allowlisted callback provider", async () => {
      const res = await request(app).get("/api/v1/auth/callback/twitter");
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("Security: returnTo Redirects & CORS Allowlist", () => {
    it("auth: returnTo parameter is sanitized to prevent open redirect vulnerabilities", async () => {
      vi.spyOn(googleStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code, _params, callback) => {
          callback(null, "token_returnto", "refresh_returnto", {});
        }
      );
      vi.spyOn(googleStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "google_returnto_uid",
          displayName: "ReturnTo User",
          emails: [{ value: "returnto@example.com", verified: true }],
        });
      });

      // 1. Malicious open redirect attempt: //attacker.com
      const agentAttack = request.agent(app);
      const attackInit = await agentAttack.get(
        "/api/v1/auth/google?returnTo=//attacker.com"
      );
      const attackState = new URL(attackInit.headers["location"]!).searchParams.get(
        "state"
      )!;
      const attackRes = await agentAttack.get(
        `/api/v1/auth/callback/google?code=mock&state=${attackState}`
      );
      expect(attackRes.headers["location"]).toBe("/");

      // 2. Legitimate relative path: /rooms/algorithms-practice
      const agentLegit = request.agent(app);
      const legitInit = await agentLegit.get(
        "/api/v1/auth/google?returnTo=/rooms/algorithms-practice"
      );
      const legitState = new URL(legitInit.headers["location"]!).searchParams.get(
        "state"
      )!;
      const legitRes = await agentLegit.get(
        `/api/v1/auth/callback/google?code=mock&state=${legitState}`
      );
      expect(legitRes.headers["location"]).toBe("/rooms/algorithms-practice");
    });

    it("auth: CORS allowlist allows configured origins and blocks untrusted cross-origin requests", async () => {
      const allowedRes = await request(app)
        .get("/api/v1/auth/google")
        .set("Origin", "http://localhost:5173");

      expect(allowedRes.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173"
      );

      const blockedRes = await request(app)
        .get("/api/v1/auth/google")
        .set("Origin", "https://malicious-attacker.com");

      expect(blockedRes.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  describe("Verified Email Logic & First-Login Preservation", () => {
    it("auth: Google and GitHub store null when email is unverified", async () => {
      const agent = request.agent(app);
      const initRes = await agent.get("/api/v1/auth/google");
      const state = new URL(initRes.headers["location"]!).searchParams.get("state")!;

      vi.spyOn(googleStrategy._oauth2, "getOAuthAccessToken").mockImplementation(
        (_code, _params, callback) => {
          callback(null, "token_unverified", "refresh_unverified", {});
        }
      );
      vi.spyOn(googleStrategy, "userProfile").mockImplementation((_token, done) => {
        done(null, {
          id: "google_unverified_uid",
          displayName: "Unverified Google User",
          emails: [{ value: "fake@unverified.org", verified: false }],
        });
      });

      await agent.get(`/api/v1/auth/callback/google?code=code_u&state=${state}`);

      const user = await UserModel.findOne({ providerId: "google_unverified_uid" });
      expect(user).not.toBeNull();
      expect(user?.email).toBeNull();
    });

    it("auth: preserves modified displayName on subsequent logins", async () => {
      const initial = await userRepo.upsertUser({
        provider: "google",
        providerId: "idempotent_sub_999",
        displayName: "Original Google Name",
        email: "idempotent@pairprep.test",
        avatarUrl: "https://example.com/avatar1.png",
      });

      expect(initial.displayName).toBe("Original Google Name");

      await userRepo.updateDisplayName(initial.id, "Custom Handcrafted Name");

      const secondLogin = await userRepo.upsertUser({
        provider: "google",
        providerId: "idempotent_sub_999",
        displayName: "Original Google Name",
        email: "idempotent-updated@pairprep.test",
        avatarUrl: "https://example.com/new_avatar.png",
      });

      expect(secondLogin.displayName).toBe("Custom Handcrafted Name");
      expect(secondLogin.email).toBe("idempotent-updated@pairprep.test");
    });
  });
});
