# Landing Page Asset Registry & Licenses

This document records the provenance, creation tools, licensing, and verification status of all static assets (images, logos, and fonts) bundled with the PairPrep web application.

> **Honesty & Verification Policy**: Upstream provenance must be documented truthfully. If an asset was imported from a third-party template or AI generation without a verifiable chain-of-title or published source license, it is explicitly classified as **Unverified** and unknown details are marked as **unknown**. Only assets with inspectable repository licenses (such as npm `@fontsource` packages with official SIL Open Font License files) are classified as **Verified**.

---

## 1. Visual Assets (`apps/web/public/images/`)

| File Name | Dimensions | File Size | Source & Provenance | Tool / Generator & Date | Declared / Upstream License | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pairprep-logo.png` | 512 × 512 | 4.07 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `hero-terrain.webp` | 1920 × 1088 | 204.50 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `hero-terrain-960w.webp` | 960 × 544 | 60.11 KB | Derived from `hero-terrain.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |
| `hero-rocks-polished.webp` | 1920 × 640 | 212.17 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `hero-rocks-polished-960w.webp` | 960 × 320 | 55.72 KB | Derived from `hero-rocks-polished.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |
| `mist-band.webp` | 1920 × 300 | 31.02 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `mountains.webp` | 1280 × 720 | 120.96 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `mountains-960w.webp` | 960 × 540 | 45.54 KB | Derived from `mountains.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |
| `painting-landscape.webp` | 1280 × 800 | 231.26 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `painting-landscape-960w.webp` | 960 × 600 | 66.37 KB | Derived from `painting-landscape.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |
| `footer-hands.webp` | 1200 × 800 | 70.72 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `footer-rocks.webp` | 1920 × 600 | 224.33 KB | Exported from `pairprep-ui-main.zip` | unknown | unknown | **Unverified** |
| `footer-rocks-960w.webp` | 960 × 300 | 61.24 KB | Derived from `footer-rocks.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |
| `auth-nature.webp` | 1920 × 1080 | 218.70 KB | Exported from `pairprep-ui-main (1).zip` | unknown | unknown | **Unverified** |
| `auth-nature-960w.webp` | 960 × 540 | 80.64 KB | Derived from `auth-nature.webp` via canvas resize | Chromium Canvas 2D (2026-11-05) | unknown | **Unverified** |

---

## 2. Typography (`@fontsource/*` Packages)

All fonts are installed strictly as self-hosted npm packages in `apps/web/package.json` and bundled locally into `dist/assets/` during the Vite production build. We import latin-only CSS subsets to prevent loading unneeded glyph subsets. No external network requests or Google Fonts CDN calls occur.

| Font Family | Package & Version | Maintainer / Author | Upstream License | Proof & Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Instrument Serif** | `@fontsource/instrument-serif@5.3.0` | Rodrigo Fuenzalida, Jordan Engel | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/instrument-serif/LICENSE` | **Verified** |
| **Geist Sans** | `@fontsource/geist-sans@5.3.0` | Vercel Inc. | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/geist-sans/LICENSE` | **Verified** |
| **JetBrains Mono** | `@fontsource/jetbrains-mono@5.3.0` | JetBrains s.r.o. | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/jetbrains-mono/LICENSE` | **Verified** |

---

## 3. Privacy & Origin Isolation Guarantees

1. **Origin-Relative Asset Paths**: All visual assets in `apps/web/src/marketing/` reference local paths under `/images/*` (served from `apps/web/public/images/`).
2. **Zero Runtime External Dependencies**: The application does not load third-party trackers, analytics, remote stylesheets, or third-party script bundles.
3. **Automated CI Scans**: The build is verified by an automated test suite (`apps/web/src/marketing/__tests__/origin-isolation.test.tsx`) scanning `marketing.css` and the production `dist/` directory for external URLs.
