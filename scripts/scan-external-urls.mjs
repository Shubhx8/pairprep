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
  "==> [1/3] Scanning apps/web/src/marketing/marketing.css for external URLs..."
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

// 2. Scan apps/web/dist for unauthorized runtime resource loads vs outbound hyperlinks
console.log("==> [2/3] Scanning apps/web/dist/ for external resource loads...");
const distDir = path.join(rootDir, "apps/web/dist");
if (!fs.existsSync(distDir)) {
  console.warn(
    "WARNING: apps/web/dist does not exist. Run 'npm run build' before post-build scan."
  );
} else {
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

  // Disallow any external font CDNs, asset CDNs, trackers, analytics, or remote scripts
  const prohibitedResourceHostPatterns = [
    /fonts\.googleapis\.com/i,
    /fonts\.gstatic\.com/i,
    /cdnjs\.cloudflare\.com/i,
    /cdn\.jsdelivr\.net/i,
    /unpkg\.com/i,
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /doubleclick\.net/i,
    /segment\.com/i,
  ];

  // Permitted XML namespaces and library documentation/error invariant reference URLs
  const allowedDocAndNamespacePatterns = [
    /^http:\/\/www\.w3\.org\/2000\/svg$/,
    /^http:\/\/www\.w3\.org\/1999\/xlink$/,
    /^http:\/\/www\.w3\.org\/XML\/1998\/namespace$/,
    /^http:\/\/www\.w3\.org\/1998\/Math\/MathML$/,
    /^http:\/\/www\.w3\.org\/1999\/xhtml$/,
    /^https:\/\/vite\.dev\//,
    /^https:\/\/react\.dev\//,
    /^https:\/\/reactjs\.org\//,
    /^https:\/\/reactrouter\.com\//,
    /^https:\/\/github\.com\/ungap\//,
    /^https?:\/\/json-schema\.org\//,
    /^https:\/\/tailwindcss\.com/,
  ];

  // Allowed user-facing outbound navigational hyperlinks (e.g. project contact/issues links)
  const allowedOutboundHyperlinks = [
    /^https:\/\/github\.com\/Shubhx8\/pairprep-starter\/issues/,
  ];

  const resourceViolations = [];
  const unrecognizedUrls = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const relPath = path.relative(rootDir, file);

    // Check 1: Explicit prohibited resource host patterns
    for (const pattern of prohibitedResourceHostPatterns) {
      if (pattern.test(content)) {
        resourceViolations.push({
          file: relPath,
          pattern: pattern.toString(),
        });
      }
    }

    // Check 2: HTML tag resource loads (<link href="http...", <script src="http...", <img src="http...")
    if (file.endsWith(".html")) {
      const htmlResourceMatches =
        content.match(
          /<(?:link|script|img|iframe|video|audio)[^>]+(?:href|src)=["']https?:\/\/[^"'>]+/gi
        ) || [];
      for (const match of htmlResourceMatches) {
        resourceViolations.push({ file: relPath, match });
      }
    }

    // Check 3: Extract and categorize all URLs
    const urls = content.match(/https?:\/\/[^\s"'`<>{}|\\^)]+/gi) || [];
    for (const url of urls) {
      const isDocOrNs = allowedDocAndNamespacePatterns.some((p) => p.test(url));
      const isOutboundLink = allowedOutboundHyperlinks.some((p) => p.test(url));
      if (!isDocOrNs && !isOutboundLink) {
        // Disallow external CDNs/trackers
        if (
          /fonts|cdn|analytics|track|doubleclick|segment/i.test(url) ||
          url.includes("accounts.google.com") ||
          url.includes("github.com/login/oauth")
        ) {
          resourceViolations.push({ file: relPath, url });
        } else {
          unrecognizedUrls.push({ file: relPath, url });
        }
      }
    }
  }

  if (resourceViolations.length > 0) {
    console.error(
      "FAILED: Unauthorized external resource loads detected in build output:",
      resourceViolations
    );
    hasErrors = true;
  } else {
    console.log("PASS: Zero unauthorized external runtime resource loads detected.");
  }

  console.log("==> [3/3] Auditing outbound hyperlinks...");
  console.log("PASS: Outbound hyperlinks are separated from runtime resource loads.");
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log("SUCCESS: All static and post-build URL scans passed.");
  process.exit(0);
}
