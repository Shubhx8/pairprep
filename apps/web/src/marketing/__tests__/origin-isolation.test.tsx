import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
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

  it("static scan: marketing.css contains zero external URLs or remote CDN imports", () => {
    const cssPath = path.resolve(__dirname, "../marketing.css");
    const content = fs.readFileSync(cssPath, "utf-8");

    // Must not contain any external url(...) references
    const urlMatches = content.match(/url\(([^)]+)\)/gi) || [];
    const externalUrls = urlMatches.filter((entry) => /https?:\/\//i.test(entry));
    expect(externalUrls).toEqual([]);

    // Must not contain any http:// or https:// addresses
    const httpMatches = content.match(/https?:\/\/[^\s"')]+/gi) || [];
    expect(httpMatches).toEqual([]);
  });

  it("post-build scan: dist output files contain zero unauthorized external CDN or tracking URLs", () => {
    const distDir = path.resolve(__dirname, "../../../../dist");
    if (!fs.existsSync(distDir)) {
      return; // Skip if run before build
    }

    const getFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...getFiles(full));
        } else if (/\.(html|css|js)$/i.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    };

    const files = getFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const forbiddenDomains = [
      /fonts\.googleapis\.com/i,
      /fonts\.gstatic\.com/i,
      /cdnjs\.cloudflare\.com/i,
      /cdn\.jsdelivr\.net/i,
      /unpkg\.com/i,
      /google-analytics\.com/i,
      /googletagmanager\.com/i,
      /doubleclick\.net/i,
    ];

    const violations: { file: string; match: string }[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      for (const pattern of forbiddenDomains) {
        if (pattern.test(content)) {
          violations.push({ file: path.basename(file), match: pattern.toString() });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
