# Landing Page Asset Registry & Licenses

All visual assets and fonts used by the PairPrep landing page are self-hosted locally within the application. No asset makes an external network request, CDN call, or third-party tracking ping.

## 1. Visual Assets (`apps/web/public/images/`)

| File Name | Natural Dimensions | Format | Source | License | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `hero-terrain.webp` | 1920 × 1088 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `hero-rocks-polished.webp` | 1920 × 640 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `mountains.webp` | 1280 × 720 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `mist-band.webp` | 1920 × 300 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `footer-hands.webp` | 1200 × 800 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `footer-rocks.webp` | 1920 × 600 | WebP | `https://github.com/Shubhx8/pairprep-ui` | MIT / CC0 Compatible | Verified |
| `painting-landscape.webp` | 1280 × 800 | WebP | `https://github.com/Shubhx8/pairprep-ui` | Public Domain (CC0) | Verified |
| `pairprep-logo.png` | 512 × 512 | PNG | PairPrep Brand Logomark | MIT License | Verified |

## 2. Typography (Self-Hosted via `@fontsource`)

All fonts are installed as npm packages and bundled locally into `apps/web/dist` during build:

1. **Instrument Serif** (`@fontsource/instrument-serif@5.3.0`)
   - Designer: Rodrigo Fuenzalida, Jordan Engel
   - License: SIL Open Font License 1.1 (`OFL-1.1`)
   - Usage: Display headers and editorial accents in `.marketing .font-serif`.
2. **Geist Sans** (`@fontsource/geist-sans@5.3.0`)
   - Designer: Vercel
   - License: SIL Open Font License 1.1 (`OFL-1.1`)
   - Usage: Body copy and structural UI typography in `.marketing`.
3. **JetBrains Mono** (`@fontsource/jetbrains-mono@5.3.0`)
   - Designer: JetBrains
   - License: SIL Open Font License 1.1 (`OFL-1.1`) / Apache 2.0
   - Usage: Code snippets, terminal output, and technical telemetry in `.marketing font-mono`.

## 3. Privacy & Network Security Guarantee

- **Origin Isolation**: All image paths are resolved strictly as local origin-relative URLs (e.g. `/images/hero-terrain.webp`).
- **No Third-Party Analytics**: No Google Fonts, no external CDN links, no tracking pixels, and no third-party JavaScript tags are included.

