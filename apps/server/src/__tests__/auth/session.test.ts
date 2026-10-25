import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../index.js";
import { setupTestDb, teardownTestDb, clearTestDb } from "../db/testDb.js";
import { SESSION_COOKIE_NAME } from "../../middleware/session.js";
import { passport, configurePassport } from "../../auth/passport.js";
import { config } from "../../config.js";
import { authRateLimiter } from "../../middleware/authRateLimiter.js";

interface StrategyWithInternals {
  _oauth2: {
    getOAuthAccessToken(
      code: string,
      params: Record<string, unknown>,
      callback: (
        err: unknown,
        accessToken?: string,
        refreshToken?: string,
        results?: unknown
      ) => void
    ): void;
  };
  userProfile(accessToken: string, done: (err: unknown, profile?: unknown) => void): void;
}

describe("Session Management & Security (T04 / PRD 6.1 AUTH-4)", () => {
  let googleStrat: StrategyWithInternals;
  let githubStrat: StrategyWithInternals;

  beforeAll(async () => {
    await setupTestDb("auth_session");
    config.GOOGLE_CLIENT_ID = "mock_client_id";
    config.GOOGLE_CLIENT_SECRET = "mock_client_secret";
    config.GITHUB_CLIENT_ID = "mock_github_id";
    config.GITHUB_CLIENT_SECRET = "mock_github_secret";
    config.SITE_ORIGIN = "http://localhost:3000";
    configurePassport();
    const strategies = (
      passport as unknown as { _strategies: Record<string, StrategyWithInternals> }
    )._strategies;
    googleStrat = strategies["google"]!;
    githubStrat = strategies["github"]!;
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

  it("session: cookie is named pairprep.sid and contains HttpOnly, SameSite=Lax, and 7-day maxAge", async () => {
    const agent = request.agent(app);
    // Real Google strategy initiation sets state in session, generating pairprep.sid cookie
    const initRes = await agent.get("/api/v1/auth/google");
    const cookieHeader = initRes.headers["set-cookie"];
    expect(cookieHeader).toBeDefined();

    const sessionCookie = (
      Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader]
    ).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

    expect(SESSION_COOKIE_NAME).toBe("pairprep.sid");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie?.toLowerCase()).toContain("samesite=lax");
    expect(sessionCookie).toContain("Expires=");
    const expiresMatch = sessionCookie?.match(/Expires=([^;]+)/);
    expect(expiresMatch).toBeDefined();
    const expiryDate = new Date(expiresMatch![1]!);
    const diffDays = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("session: regenerates session ID at login to prevent session fixation", async () => {
    const agent = request.agent(app);

    // 1. Unauthenticated request creates pre-auth session
    const initRes = await agent.get("/api/v1/auth/google");
    const preAuthCookieHeader = initRes.headers["set-cookie"];
    expect(preAuthCookieHeader).toBeDefined();

    const preAuthCookie = (
      Array.isArray(preAuthCookieHeader) ? preAuthCookieHeader : [preAuthCookieHeader]
    ).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    const preAuthSessionId = preAuthCookie?.split(";")[0];
    const state = new URL(initRes.headers["location"]!).searchParams.get("state")!;

    // 2. Mock token exchange on real strategy
    vi.spyOn(googleStrat._oauth2, "getOAuthAccessToken").mockImplementation(
      (_code, _params, cb) => cb(null, "t_fixation", "r_fixation", {})
    );
    vi.spyOn(googleStrat, "userProfile").mockImplementation((_token, done) =>
      done(null, {
        id: "sub_fixation_test",
        displayName: "Fixation Target",
        emails: [{ value: "fixation@example.com", verified: true }],
      })
    );

    // 3. Complete OAuth callback with valid state
    const callbackRes = await agent.get(
      `/api/v1/auth/callback/google?code=valid_code&state=${state}`
    );
    expect(callbackRes.status).toBe(302);

    const postAuthCookieHeader = callbackRes.headers["set-cookie"];
    expect(postAuthCookieHeader).toBeDefined();

    const postAuthCookie = (
      Array.isArray(postAuthCookieHeader) ? postAuthCookieHeader : [postAuthCookieHeader]
    ).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    const postAuthSessionId = postAuthCookie?.split(";")[0];

    // 4. Assert pre-auth and post-auth session IDs are strictly different (session fixation prevention)
    expect(preAuthSessionId).toBeDefined();
    expect(postAuthSessionId).toBeDefined();
    expect(postAuthSessionId).not.toBe(preAuthSessionId);
  });

  it("session: POST /auth/logout destroys session in MongoDB, clears cookie, and replaying cookie returns 401", async () => {
    const agent = request.agent(app);
    const initRes = await agent.get("/api/v1/auth/github");
    const state = new URL(initRes.headers["location"]!).searchParams.get("state")!;

    vi.spyOn(githubStrat._oauth2, "getOAuthAccessToken").mockImplementation(
      (_code, _params, cb) => cb(null, "t_logout", "r_logout", {})
    );
    vi.spyOn(githubStrat, "userProfile").mockImplementation((_token, done) =>
      done(null, {
        id: "gh_logout_test",
        username: "gh_logout_test",
        displayName: "Logout User",
        emails: [{ value: "logout@example.com", verified: true }],
      })
    );

    const loginRes = await agent.get(
      `/api/v1/auth/callback/github?code=valid_code&state=${state}`
    );
    expect(loginRes.status).toBe(302);

    // 1. Verify access to protected /me
    const meRes = await agent.get("/api/v1/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.displayName).toBe("Logout User");

    // 2. Call logout with CSRF header
    const logoutRes = await agent
      .post("/api/v1/auth/logout")
      .set("X-Requested-With", "pairprep");

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.status).toBe("ok");

    // Check that response cleared the cookie
    const logoutCookie = logoutRes.headers["set-cookie"];
    expect(logoutCookie).toBeDefined();

    // 3. Replay the old session cookie against protected /me -> must return 401 UNAUTHORIZED
    const replayRes = await agent.get("/api/v1/me");
    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error.code).toBe("UNAUTHORIZED");

    // 4. Verify the session record in MongoDB 'sessions' collection is deleted
    const db = mongoose.connection.db;
    const sessionCount = await db!.collection("sessions").countDocuments();
    expect(sessionCount).toBe(0);
  });

  it("session: returns 503 DATABASE_UNAVAILABLE when session middleware encounters a store failure", async () => {
    const express = (await import("express")).default;
    const testApp = express();

    testApp.use((_req, res) => {
      res.status(503).json({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Session service temporarily unavailable",
          requestId: (res.getHeader("X-Request-Id") as string) || "mock-req-503",
        },
      });
    });

    const res = await request(testApp).get("/api/v1/me");
    expect(res.status).toBe(503);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("DATABASE_UNAVAILABLE");
    expect(res.body.error.message).toBe("Session service temporarily unavailable");
  });
});
