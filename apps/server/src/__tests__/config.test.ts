import { describe, it, expect } from "vitest";
import { loadConfig } from "../config.js";

describe("Server Config Module (T01)", () => {
  it("environment: proves server project runs in node environment and does not load web setup file", () => {
    const g = globalThis as unknown as { window?: unknown; document?: unknown };
    expect(typeof g.window).toBe("undefined");
    expect(typeof g.document).toBe("undefined");
  });
  it("config: defaults PORT to 3000 when PORT is not provided in environment", () => {
    const mockEnv = {
      NODE_ENV: "development",
    };

    const cfg = loadConfig(mockEnv as unknown as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.AUTH_RATE_LIMIT_MAX).toBe(30);
  });

  it("config: defaults AUTH_RATE_LIMIT_MAX to 30 when not provided in environment", () => {
    const cfg = loadConfig({
      NODE_ENV: "development",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.AUTH_RATE_LIMIT_MAX).toBe(30);
  });

  it("config: successfully validates and loads complete environment schema", () => {
    const mockEnv = {
      NODE_ENV: "production",
      PORT: "3000",
      MONGODB_URI: "mongodb+srv://user:pass@cluster0.mongodb.net/pairprep",
      SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
      SITE_ORIGIN: "https://pairprep-live.eastasia.cloudapp.azure.com",
      GIT_SHA: "commit-sha-12345",
      RATE_LIMIT_MAX: "50",
      TRUSTED_PROXY_CIDRS: "127.0.0.1,172.20.0.2",
    };

    const cfg = loadConfig(mockEnv as unknown as NodeJS.ProcessEnv);
    expect(cfg.NODE_ENV).toBe("production");
    expect(cfg.PORT).toBe(3000);
    expect(cfg.SITE_ORIGIN).toBe("https://pairprep-live.eastasia.cloudapp.azure.com");
    expect(cfg.GIT_SHA).toBe("commit-sha-12345");
    expect(cfg.RATE_LIMIT_MAX).toBe(50);
    expect(cfg.TRUSTED_PROXY_CIDRS).toBe("127.0.0.1,172.20.0.2");
  });

  it("config: allows MONGODB_URI and SESSION_SECRET to be optional in T01", () => {
    const minimalEnv = {
      NODE_ENV: "test",
    };

    const cfg = loadConfig(minimalEnv as unknown as NodeJS.ProcessEnv);
    expect(cfg.MONGODB_URI).toBeUndefined();
    expect(cfg.SESSION_SECRET).toBeUndefined();
    expect(cfg.PORT).toBe(3000);
  });

  it("config: throws when invalid PORT is provided", () => {
    expect(() =>
      loadConfig({
        PORT: "not-a-number",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/PORT/);

    expect(() =>
      loadConfig({
        PORT: "70000", // > 65535
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/PORT/);
  });

  it("config: throws when invalid NODE_ENV is provided", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "staging", // not development/production/test
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/NODE_ENV/);
  });

  it("config: startup error message lists missing variable names and contains no secret values", () => {
    const invalidEnv = {
      PORT: "invalid-port",
      MONGODB_URI: "invalid-uri-scheme",
      SESSION_SECRET: "too-short",
    };

    try {
      loadConfig(invalidEnv as unknown as NodeJS.ProcessEnv);
      expect.unreachable("Should have thrown error");
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      expect(errorMessage).toContain("PORT");
      expect(errorMessage).toContain("MONGODB_URI");
      expect(errorMessage).toContain("SESSION_SECRET");
      // Assert secret values are NOT leaked in the error message
      expect(errorMessage).not.toContain("invalid-uri-scheme");
      expect(errorMessage).not.toContain("too-short");
    }
  });

  it("config: in production mode requires MONGODB_URI, SESSION_SECRET (32+ chars) and https SITE_ORIGIN", () => {
    // Missing MONGODB_URI in production
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
        SITE_ORIGIN: "https://pairprep.example.com",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/MONGODB_URI/);

    // Missing SESSION_SECRET in production
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep",
        SITE_ORIGIN: "https://pairprep.example.com",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/SESSION_SECRET/);

    // Short SESSION_SECRET in production
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep",
        SESSION_SECRET: "short_secret_under_32_chars",
        SITE_ORIGIN: "https://pairprep.example.com",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/SESSION_SECRET/);

    // Invalid MONGODB_URI scheme in production (must be mongodb:// or mongodb+srv://)
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "postgres://user:pass@localhost:5432/db",
        SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
        SITE_ORIGIN: "https://pairprep.example.com",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/MONGODB_URI/);

    // Non-https SITE_ORIGIN in production (http rejected for non-localhost)
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep",
        SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
        SITE_ORIGIN: "http://pairprep.example.com",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/SITE_ORIGIN/);

    // http is allowed for localhost in production
    const localhostProd = loadConfig({
      NODE_ENV: "production",
      MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep",
      SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
      SITE_ORIGIN: "http://localhost:3000",
      TRUSTED_PROXY_CIDRS: "127.0.0.1,172.20.0.2",
    } as unknown as NodeJS.ProcessEnv);
    expect(localhostProd.SITE_ORIGIN).toBe("http://localhost:3000");

    // Missing SITE_ORIGIN in production (with empty string)
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://127.0.0.1:27017/pairprep",
        SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
        SITE_ORIGIN: "   ",
        TRUSTED_PROXY_CIDRS: "127.0.0.1,172.20.0.2",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/SITE_ORIGIN/);

    // Fails with variable names only
    try {
      loadConfig({
        NODE_ENV: "production",
        MONGODB_URI: "",
        SESSION_SECRET: "short",
        SITE_ORIGIN: "http://insecure.com",
      } as unknown as NodeJS.ProcessEnv);
      expect.unreachable("Should have thrown error");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("MONGODB_URI");
      expect(msg).toContain("SESSION_SECRET");
      expect(msg).toContain("SITE_ORIGIN");
      expect(msg).not.toContain("short");
      expect(msg).not.toContain("http://insecure.com");
    }

    // Valid production config with https and mongodb+srv succeeds
    const validProd = loadConfig({
      NODE_ENV: "production",
      MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/pairprep",
      SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
      SITE_ORIGIN: "https://pairprep.example.com",
      TRUSTED_PROXY_CIDRS: "127.0.0.1,172.20.0.2",
    } as unknown as NodeJS.ProcessEnv);
    expect(validProd.NODE_ENV).toBe("production");
    expect(validProd.MONGODB_URI).toBe(
      "mongodb+srv://user:pass@cluster.mongodb.net/pairprep"
    );
    expect(validProd.SESSION_SECRET).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(validProd.SITE_ORIGIN).toBe("https://pairprep.example.com");
  });

  it("config: requires explicit, narrow TRUSTED_PROXY_CIDRS in production and rejects broad ranges", () => {
    const baseProd = {
      NODE_ENV: "production",
      MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/pairprep",
      SESSION_SECRET: "abcdef1234567890abcdef1234567890abcdef12",
      SITE_ORIGIN: "https://pairprep.example.com",
    };

    // Missing TRUSTED_PROXY_CIDRS (defaults to loopback, rejected in production)
    expect(() =>
      loadConfig({
        ...baseProd,
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Empty or whitespace TRUSTED_PROXY_CIDRS
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "   ",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Bare "loopback" keyword in production
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "loopback",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Prohibited broad private range 10.0.0.0/8
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Prohibited broad private range 172.16.0.0/12
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "172.16.0.0/12",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Prohibited broad private range 192.168.0.0/16
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "192.168.0.0/16",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Prohibited 0.0.0.0/0
    expect(() =>
      loadConfig({
        ...baseProd,
        TRUSTED_PROXY_CIDRS: "0.0.0.0/0",
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/TRUSTED_PROXY_CIDRS/);

    // Exact IP or specific narrow CIDR is accepted
    const cfg = loadConfig({
      ...baseProd,
      TRUSTED_PROXY_CIDRS: "127.0.0.1, 172.20.0.5/32, ::1",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.TRUSTED_PROXY_CIDRS).toBe("127.0.0.1, 172.20.0.5/32, ::1");
  });

  it("config: keeps MONGODB_URI and SESSION_SECRET optional in development and test", () => {
    const devConfig = loadConfig({
      NODE_ENV: "development",
    } as unknown as NodeJS.ProcessEnv);
    expect(devConfig.MONGODB_URI).toBeUndefined();
    expect(devConfig.SESSION_SECRET).toBeUndefined();
    expect(devConfig.SITE_ORIGIN).toBe("http://localhost:3000"); // http allowed in dev

    const testConfig = loadConfig({
      NODE_ENV: "test",
    } as unknown as NodeJS.ProcessEnv);
    expect(testConfig.MONGODB_URI).toBeUndefined();
    expect(testConfig.SESSION_SECRET).toBeUndefined();
    expect(testConfig.SITE_ORIGIN).toBe("http://localhost:3000"); // http allowed in test
  });
});
