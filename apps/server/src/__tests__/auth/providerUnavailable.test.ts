import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import session from "express-session";
import { authRouter } from "../../routes/auth.js";
import { passport } from "../../auth/passport.js";

describe("OAuth Provider Unavailable Guard (T06 Fixes)", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.restoreAllMocks();
    app = express();
    app.use(
      session({
        secret: "test_session_secret_for_provider_unavailable_tests",
        resave: false,
        saveUninitialized: false,
      })
    );
    app.use(passport.initialize());
    app.use(passport.session());
    app.use("/api/v1/auth", authRouter);
  });

  it("GET /api/v1/auth/google redirects to /login?error=provider_unavailable when google strategy is not registered", async () => {
    const origStrategy = (
      passport as unknown as { _strategy: (name: string) => unknown }
    )._strategy.bind(passport);

    vi.spyOn(
      passport as unknown as { _strategy: (name: string) => unknown },
      "_strategy"
    ).mockImplementation((name: string) => {
      if (name === "google") return undefined;
      return origStrategy(name);
    });

    const res = await request(app).get("/api/v1/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=provider_unavailable");
  });

  it("GET /api/v1/auth/github redirects to /login?error=provider_unavailable when github strategy is not registered", async () => {
    const origStrategy = (
      passport as unknown as { _strategy: (name: string) => unknown }
    )._strategy.bind(passport);

    vi.spyOn(
      passport as unknown as { _strategy: (name: string) => unknown },
      "_strategy"
    ).mockImplementation((name: string) => {
      if (name === "github") return undefined;
      return origStrategy(name);
    });

    const res = await request(app).get("/api/v1/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=provider_unavailable");
  });

  it("GET /api/v1/auth/callback/google redirects to /login?error=provider_unavailable when strategy is not registered", async () => {
    const origStrategy = (
      passport as unknown as { _strategy: (name: string) => unknown }
    )._strategy.bind(passport);

    vi.spyOn(
      passport as unknown as { _strategy: (name: string) => unknown },
      "_strategy"
    ).mockImplementation((name: string) => {
      if (name === "google") return undefined;
      return origStrategy(name);
    });

    const res = await request(app).get("/api/v1/auth/callback/google?code=abc&state=xyz");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=provider_unavailable");
  });

  it("GET /api/v1/auth/callback/github redirects to /login?error=provider_unavailable when strategy is not registered", async () => {
    const origStrategy = (
      passport as unknown as { _strategy: (name: string) => unknown }
    )._strategy.bind(passport);

    vi.spyOn(
      passport as unknown as { _strategy: (name: string) => unknown },
      "_strategy"
    ).mockImplementation((name: string) => {
      if (name === "github") return undefined;
      return origStrategy(name);
    });

    const res = await request(app).get("/api/v1/auth/callback/github?code=abc&state=xyz");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/login?error=provider_unavailable");
  });
});
