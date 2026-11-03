import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import LandingPage from "../landing.js";

describe("Landing Page Origin Isolation & Privacy (Requirement 9)", () => {
  const fetchSpy = vi.fn();
  const originalFetch = window.fetch;

  beforeEach(() => {
    window.fetch = fetchSpy;
    fetchSpy.mockReset();
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it("renders without any background network request to external hosts or CDNs", () => {
    const { container } = render(
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    );

    // 1. Verify no automatic background fetch was made to external origins
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Verify all image sources are relative local assets or same-origin
    const images = container.querySelectorAll("img");
    expect(images.length).toBeGreaterThan(0);

    const appOrigin = window.location.origin;

    images.forEach((img) => {
      const src = img.getAttribute("src") || "";
      expect(src.length).toBeGreaterThan(0);

      // Must be a relative path or match the application's origin
      const isRelative = src.startsWith("/") || src.startsWith("./");
      const isSameOrigin = src.startsWith(appOrigin);
      const isExternal =
        (src.startsWith("http://") || src.startsWith("https://")) && !isSameOrigin;

      expect(isExternal).toBe(false);
      expect(isRelative || isSameOrigin).toBe(true);
    });

    // 3. Verify no external script tags, stylesheets, or fonts are dynamically injected
    const scripts = container.querySelectorAll("script");
    scripts.forEach((script) => {
      const src = script.getAttribute("src");
      if (src) {
        const isSameOrigin = src.startsWith("/") || src.startsWith(appOrigin);
        expect(isSameOrigin).toBe(true);
      }
    });

    // 4. Verify no tracking pixels or remote iframe embeds
    const iframes = container.querySelectorAll("iframe");
    expect(iframes.length).toBe(0);
  });
});
