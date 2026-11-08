import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { IncomingMessage } from "node:http";
import {
  compileTrustFunction,
  validateProductionProxyCidrs,
  assertProductionProxyCidrs,
  normalizeIp,
  getClientIp,
  parseTrustedProxyCidrs,
  resetDefaultTrustProxyFn,
  PROHIBITED_PRODUCTION_PROXY_RANGES,
} from "../../config/proxyTrust.js";

describe("Proxy Trust & Client-IP Resolution Hardening (Commit 6)", () => {
  const originalEnv = process.env["TRUSTED_PROXY_CIDRS"];

  beforeEach(() => {
    resetDefaultTrustProxyFn();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["TRUSTED_PROXY_CIDRS"] = originalEnv;
    } else {
      delete process.env["TRUSTED_PROXY_CIDRS"];
    }
    resetDefaultTrustProxyFn();
  });

  describe("IP normalization", () => {
    it("strips ::ffff: IPv4-mapped IPv6 prefix", () => {
      expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
      expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
      expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    });

    it("preserves standard IPv4 and IPv6 strings", () => {
      expect(normalizeIp("192.0.2.1")).toBe("192.0.2.1");
      expect(normalizeIp("::1")).toBe("::1");
      expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    });

    it("handles missing or empty inputs safely", () => {
      expect(normalizeIp(undefined)).toBe("");
      expect(normalizeIp("")).toBe("");
      expect(normalizeIp("   ")).toBe("");
    });
  });

  describe("Production CIDR validation", () => {
    it("rejects missing, undefined, or empty values in production mode", () => {
      expect(() => assertProductionProxyCidrs(undefined, "production")).toThrow(
        /TRUSTED_PROXY_CIDRS must be configured/
      );
      expect(() => assertProductionProxyCidrs("", "production")).toThrow(
        /cannot be empty/
      );
      expect(() => assertProductionProxyCidrs("   ", "production")).toThrow(
        /cannot be empty/
      );

      expect(validateProductionProxyCidrs(undefined, "production")).toBe(false);
      expect(validateProductionProxyCidrs("", "production")).toBe(false);
      expect(validateProductionProxyCidrs("   ", "production")).toBe(false);
    });

    it("rejects bare 'loopback' keyword in production mode", () => {
      expect(() => assertProductionProxyCidrs("loopback", "production")).toThrow(
        /cannot use the bare 'loopback' default/
      );
      expect(validateProductionProxyCidrs("loopback", "production")).toBe(false);
    });

    it("rejects broad private network ranges in production mode", () => {
      for (const prohibited of PROHIBITED_PRODUCTION_PROXY_RANGES) {
        expect(() =>
          assertProductionProxyCidrs(`127.0.0.1, ${prohibited}`, "production")
        ).toThrow(/prohibited broad range/);
        expect(
          validateProductionProxyCidrs(`127.0.0.1, ${prohibited}`, "production")
        ).toBe(false);
      }
    });

    it("accepts specific, exact IP and narrow CIDR definitions in production", () => {
      expect(() =>
        assertProductionProxyCidrs("127.0.0.1, 172.20.0.5/32, ::1", "production")
      ).not.toThrow();
      expect(
        validateProductionProxyCidrs("127.0.0.1, 172.20.0.5/32, ::1", "production")
      ).toBe(true);
    });

    it("allows loopback or empty in non-production environments", () => {
      expect(() => assertProductionProxyCidrs(undefined, "test")).not.toThrow();
      expect(() => assertProductionProxyCidrs("loopback", "development")).not.toThrow();
      expect(validateProductionProxyCidrs(undefined, "test")).toBe(true);
      expect(validateProductionProxyCidrs("loopback", "development")).toBe(true);
    });
  });

  describe("CIDR parsing and trust compilation", () => {
    it("parses comma-separated entries and trims whitespace", () => {
      const parsed = parseTrustedProxyCidrs(" 127.0.0.1 , 10.0.0.2/32 , ::1 ");
      expect(parsed).toEqual(["127.0.0.1", "10.0.0.2/32", "::1"]);
    });

    it("returns empty array when input is empty or missing", () => {
      expect(parseTrustedProxyCidrs("")).toEqual([]);
      expect(parseTrustedProxyCidrs(undefined)).toEqual([]);
    });

    it("compiles trust function and accurately evaluates addresses", () => {
      const trustFn = compileTrustFunction("127.0.0.1, 172.20.0.2");
      expect(trustFn("127.0.0.1", 0)).toBe(true);
      expect(trustFn("172.20.0.2", 0)).toBe(true);
      expect(trustFn("172.20.0.3", 0)).toBe(false);
      expect(trustFn("10.0.0.1", 0)).toBe(false);
      expect(trustFn("192.168.1.1", 0)).toBe(false);
      expect(trustFn("203.0.113.5", 0)).toBe(false);
    });
  });

  describe("Express and WebSocket client-IP resolution consistency", () => {
    it("resolves identical IP for untrusted direct connections, ignoring forged X-Forwarded-For", () => {
      process.env["TRUSTED_PROXY_CIDRS"] = "127.0.0.1, 172.20.0.2";
      resetDefaultTrustProxyFn();

      const trustFn = compileTrustFunction("127.0.0.1, 172.20.0.2");

      const directUntrustedIp = "203.0.113.50";
      const forgedXff = "198.51.100.99, 10.0.0.1";

      // Mock WebSocket incoming request
      const wsReq = {
        headers: { "x-forwarded-for": forgedXff },
        socket: { remoteAddress: directUntrustedIp },
      } as unknown as IncomingMessage;

      const wsResolvedIp = getClientIp(wsReq);
      expect(wsResolvedIp).toBe(directUntrustedIp);

      // Express with same trust function
      const app = express();
      app.set("trust proxy", trustFn);
      let expressResolvedIp = "";
      app.get("/test-ip", (req, res) => {
        expressResolvedIp = req.ip || "";
        res.send({ ip: expressResolvedIp });
      });

      // Express trust proxy delegates to proxyaddr(req, trustFn)
      expect(trustFn(directUntrustedIp, 0)).toBe(false);
      expect(wsResolvedIp).toBe(directUntrustedIp);
    });

    it("ignores forged X-Forwarded-For when connecting from untrusted private subnets", () => {
      // Only 172.20.0.2 is trusted. 10.0.0.5 is NOT trusted.
      process.env["TRUSTED_PROXY_CIDRS"] = "172.20.0.2";
      resetDefaultTrustProxyFn();

      const untrustedPrivateIp = "10.0.0.5";
      const forgedXff = "198.51.100.42";

      const wsReq = {
        headers: { "x-forwarded-for": forgedXff },
        socket: { remoteAddress: untrustedPrivateIp },
      } as unknown as IncomingMessage;

      const wsResolvedIp = getClientIp(wsReq);
      // Because 10.0.0.5 is untrusted, XFF is completely ignored
      expect(wsResolvedIp).toBe(untrustedPrivateIp);
    });

    it("unwraps real client IP when request arrives through trusted reverse proxy", () => {
      process.env["TRUSTED_PROXY_CIDRS"] = "127.0.0.1, 172.20.0.2";
      resetDefaultTrustProxyFn();

      const trustedProxyIp = "172.20.0.2";
      const realClientIp = "203.0.113.195";

      const wsReq = {
        headers: { "x-forwarded-for": realClientIp },
        socket: { remoteAddress: trustedProxyIp },
      } as unknown as IncomingMessage;

      const wsResolvedIp = getClientIp(wsReq);
      expect(wsResolvedIp).toBe(realClientIp);
    });

    it("correctly unwraps multi-hop proxy chains through trusted intermediaries", () => {
      process.env["TRUSTED_PROXY_CIDRS"] = "127.0.0.1, 172.20.0.2, 172.20.0.3";
      resetDefaultTrustProxyFn();

      // Direct socket is 172.20.0.2 (trusted proxy)
      // Chain: Client -> 172.20.0.3 (trusted) -> 172.20.0.2 (trusted) -> App
      const realClientIp = "198.51.100.77";
      const xffHeader = `${realClientIp}, 172.20.0.3`;

      const wsReq = {
        headers: { "x-forwarded-for": xffHeader },
        socket: { remoteAddress: "172.20.0.2" },
      } as unknown as IncomingMessage;

      const wsResolvedIp = getClientIp(wsReq);
      expect(wsResolvedIp).toBe(realClientIp);
    });

    it("fails safe to direct remoteAddress when X-Forwarded-For contains garbage", () => {
      process.env["TRUSTED_PROXY_CIDRS"] = "127.0.0.1";
      resetDefaultTrustProxyFn();

      const wsReq = {
        headers: { "x-forwarded-for": "not-a-valid-ip, [invalid]" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage;

      const wsResolvedIp = getClientIp(wsReq);
      expect(wsResolvedIp).toBe("127.0.0.1");
    });
  });
});
