import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSyncUrl } from "../syncUrl.js";

describe("getSyncUrl", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Reset location mock before each test
    delete (window as unknown as { location?: unknown }).location;
  });

  afterEach(() => {
    (window as unknown as { location?: unknown }).location = originalLocation;
    vi.restoreAllMocks();
  });

  it("resolves ws: from http: protocol", () => {
    (window as unknown as { location: unknown }).location = {
      protocol: "http:",
      host: "localhost:5173",
    };

    const url = getSyncUrl();
    expect(url).toBe("ws://localhost:5173/sync");
  });

  it("resolves wss: from https: protocol", () => {
    (window as unknown as { location: unknown }).location = {
      protocol: "https:",
      host: "app.pairprep.com",
    };

    const url = getSyncUrl();
    expect(url).toBe("wss://app.pairprep.com/sync");
  });

  it("supports explicit overrideUrl without inspecting globals", () => {
    (window as unknown as { location: unknown }).location = {
      protocol: "http:",
      host: "should-not-be-used.com",
    };

    const url = getSyncUrl({ overrideUrl: "ws://127.0.0.1:4000/sync" });
    expect(url).toBe("ws://127.0.0.1:4000/sync");
  });

  it("supports explicit host and protocol overrides for isolated testing", () => {
    const url = getSyncUrl({ host: "custom-host:8080", protocol: "https:" });
    expect(url).toBe("wss://custom-host:8080/sync");
  });

  it("preserves exact /sync endpoint path", () => {
    const url = getSyncUrl({ host: "test.local", protocol: "http:" });
    expect(url.endsWith("/sync")).toBe(true);
  });

  it("handles environment without window gracefully without throwing (SSR safety)", () => {
    const url = getSyncUrl({ host: "127.0.0.1:3000" });
    expect(url).toBe("ws://127.0.0.1:3000/sync");
  });
});
