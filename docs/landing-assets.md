# Landing Page Asset Registry & Licenses

This document records the provenance, creation tools, licensing, and verification status of all static assets (images, logos, and fonts) bundled with the PairPrep web application.

> **Honesty & Verification Policy**: Upstream provenance must be documented truthfully. If an asset was imported from a third-party template or AI generation without an verifiable chain-of-title or published source license, it is explicitly classified as **Unverified**. Only assets with inspectable repository licenses (such as npm `@fontsource` packages with official SIL Open Font License files) are classified as **Verified**.

---

## 1. Visual Assets (`apps/web/public/images/`)

| File Name | Dimensions | File Size | Source & Provenance | Tool / Generator & Date | Declared / Upstream License | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pairprep-logo.png` | 512 × 512 | 4.07 KB | Exported from `https://github.com/Shubhx8/pairprep-ui` (pairprep-ui-main.zip) | Lovable AI code/design generation (2026-11-02) | Unverified (generated in UI export) | **Unverified** |
| `hero-terrain.webp` | 1920 × 1088 | 204.50 KB | Exported from `pairprep-ui-main.zip` | Unknown image generation / stock source (2026-11-02) | Unverified | **Unverified** |
| `hero-rocks-polished.webp` | 1920 × 640 | 212.17 KB | Exported from `pairprep-ui-main.zip` | Unknown image cutout / photo composition (2026-11-02) | Unverified | **Unverified** |
| `mist-band.webp` | 1920 × 300 | 31.02 KB | Exported from `pairprep-ui-main.zip` | Unknown mist gradient generator / stock photo (2026-11-02) | Unverified | **Unverified** |
| `mountains.webp` | 1280 × 720 | 120.96 KB | Exported from `pairprep-ui-main.zip` | Unknown landscape stock photo (2026-11-02) | Unverified | **Unverified** |
| `painting-landscape.webp` | 1280 × 800 | 231.26 KB | Exported from `pairprep-ui-main.zip` | Unknown landscape painting reproduction (2026-11-02) | Unverified | **Unverified** |
| `footer-hands.webp` | 1200 × 800 | 70.72 KB | Detail from Michelangelo's *The Creation of Adam* (Sistine Chapel, painted c. 1508–1512) | Historical artwork is in the Public Domain (CC0); specific modern digital cutout source unverified (2026-11-02) | Underlying work: Public Domain; Digital cutout: Unverified | **Unverified** |
| `footer-rocks.webp` | 1920 × 600 | 224.33 KB | Exported from `pairprep-ui-main.zip` | Unknown stock photo / asset export (2026-11-02) | Unverified | **Unverified** |
| `auth-nature.jpg` | 1920 × 1080 | 256.12 KB | Exported from `pairprep-ui-main (1).zip` | Unknown nature background photography (2026-11-02) | Unverified | **Unverified** |

---

## 2. Typography (`@fontsource/*` Packages)

All fonts are installed strictly as self-hosted npm packages in `apps/web/package.json` and bundled locally into `dist/assets/` during the Vite production build. No external network requests or Google Fonts CDN calls occur.

| Font Family | Package & Version | Designer / Maintainer | Upstream License | Proof & Verification | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Instrument Serif** | `@fontsource/instrument-serif@5.3.0` | Rodrigo Fuenzalida, Jordan Engel | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/instrument-serif/LICENSE` | **Verified** |
| **Geist Sans** | `@fontsource/geist-sans@5.3.0` | Vercel Inc. | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/geist-sans/LICENSE` | **Verified** |
| **JetBrains Mono** | `@fontsource/jetbrains-mono@5.3.0` | JetBrains s.r.o. | SIL Open Font License 1.1 (`OFL-1.1`) | `node_modules/@fontsource/jetbrains-mono/LICENSE` | **Verified** |

---

## 3. Privacy & Origin Isolation Guarantees

1. **Origin-Relative Asset Paths**: All visual assets in `apps/web/src/marketing/` reference local paths under `/images/*` (served from `apps/web/public/images/`).
2. **Zero Runtime External Dependencies**: The application does not load third-party trackers, analytics, remote stylesheets, or third-party script bundles.
3. **Automated CI Scans**: The build is verified by an automated test suite (`apps/web/src/marketing/__tests__/origin-isolation.test.tsx`) scanning `marketing.css` and the production `dist/` directory for external URLs.
