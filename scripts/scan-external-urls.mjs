/* global console, process */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

let hasErrors = false;

// 1. Static scan of marketing.css
console.log(
  "==> [1/2] Scanning apps/web/src/marketing/marketing.css for external URLs..."
);
const cssPath = path.join(rootDir, "apps/web/src/marketing/marketing.css");
if (!fs.existsSync(cssPath)) {
  console.error(`ERROR: CSS file not found at ${cssPath}`);
  hasErrors = true;
} else {
  const cssContent = fs.readFileSync(cssPath, "utf-8");
  const externalCssUrls = cssContent.match(/https?:\/\/[^\s"')]+/gi) || [];
  if (externalCssUrls.length > 0) {
    console.error("FAILED: External URLs detected in marketing.css:", externalCssUrls);
    hasErrors = true;
  } else {
    console.log("PASS: Zero external URLs found in marketing.css (100% self-hosted).");
  }
}

// 2. Post-build scan of apps/web/dist
console.log("==> [2/2] Scanning apps/web/dist/ for external URLs...");
const distDir = path.join(rootDir, "apps/web/dist");
if (!fs.existsSync(distDir)) {
  console.warn(
    "WARNING: apps/web/dist does not exist. Run 'npm run build' before post-build scan."
  );
} else {
  const allowedUrlPatterns = [
    /^http:\/\/www\.w3\.org\/2000\/svg$/,
    /^http:\/\/www\.w3\.org\/1999\/xlink$/,
    /^https:\/\/vite\.dev\//, // Vite comment / warning link in code bundle
    /^https:\/\/react\.dev\//, // React error / doc links in bundled library code
    /^https:\/\/reactjs\.org\//,
    /^https:\/\/github\.com\/login\/oauth/, // Allowed OAuth provider endpoint
    /^https:\/\/accounts\.google\.com\//, // Allowed OAuth provider endpoint
  ];

  function getFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getFiles(full));
      } else if (/\.(html|css|js)$/i.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const files = getFiles(distDir);
  console.log(`Found ${files.length} build output files to scan.`);

  const violations = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const urls = content.match(/https?:\/\/[^\s"'`<>{}|\\^]+/gi) || [];
    for (const url of urls) {
      const isAllowed = allowedUrlPatterns.some((pattern) => pattern.test(url));
      if (!isAllowed) {
        // Disallow remote font CDNs, tracking pixels, third-party analytics, remote CSS
        if (
          /fonts\.googleapis|fonts\.gstatic|cdnjs|jsdelivr|unpkg|google-analytics|doubleclick|segment/i.test(
            url
          )
        ) {
          violations.push({ file: path.relative(rootDir, file), url });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      "FAILED: Unauthorized external CDN or tracker URLs detected in build output:",
      violations
    );
    hasErrors = true;
  } else {
    console.log(
      "PASS: Zero external font, CDN, or tracker URLs detected in build output."
    );
  }
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log("SUCCESS: All static and post-build URL scans passed.");
  process.exit(0);
}
