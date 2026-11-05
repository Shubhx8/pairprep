import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseTokens(cssContent: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const variableRegex = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = variableRegex.exec(cssContent)) !== null) {
    const name = `--${match[1]}`;
    const value = match[2]?.trim();
    if (value) {
      tokens[name] = value;
    }
  }
  return tokens;
}

function hexToRgb(hex: string): [number, number, number] {
  let cleanHex = hex.replace("#", "");
  if (cleanHex.length === 3) {
    cleanHex = cleanHex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(cleanHex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(hex1: string, hex2: string): number {
  const lum1 = relativeLuminance(hexToRgb(hex1));
  const lum2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe("TOKENS-CONTRAST: Design Tokens & WCAG AA Contrast Ratios", () => {
  const tokensPath = path.resolve(__dirname, "../tokens.css");
  const cssContent = fs.readFileSync(tokensPath, "utf-8");
  const tokens = parseTokens(cssContent);

  it("tokens: defines all required Direction A tokens including overlay and font stacks", () => {
    expect(tokens["--bg-canvas"]).toBeDefined();
    expect(tokens["--bg-surface"]).toBeDefined();
    expect(tokens["--bg-surface-hover"]).toBeDefined();
    expect(tokens["--overlay"]).toBeDefined();
    expect(tokens["--border-subtle"]).toBeDefined();
    expect(tokens["--border-input"]).toBeDefined();
    expect(tokens["--primary"]).toBeDefined();
    expect(tokens["--primary-hover"]).toBeDefined();
    expect(tokens["--primary-fg"]).toBeDefined();
    expect(tokens["--success"]).toBeDefined();
    expect(tokens["--success-fg"]).toBeDefined();
    expect(tokens["--destructive"]).toBeDefined();
    expect(tokens["--destructive-fg"]).toBeDefined();
    expect(tokens["--destructive-text"]).toBe("#fb7185");
    expect(tokens["--warning"]).toBeDefined();
    expect(tokens["--warning-fg"]).toBeDefined();
    expect(tokens["--text-primary"]).toBeDefined();
    expect(tokens["--text-secondary"]).toBeDefined();
    expect(tokens["--text-subtle"]).toBeDefined();
    expect(tokens["--ring"]).toBeDefined();
    expect(tokens["--font-sans"]).toBeDefined();
    expect(tokens["--font-mono"]).toBeDefined();
  });

  const backgrounds = [
    { name: "--bg-canvas", hex: tokens["--bg-canvas"]! },
    { name: "--bg-surface", hex: tokens["--bg-surface"]! },
    { name: "--bg-surface-hover", hex: tokens["--bg-surface-hover"]! },
  ];

  it("contrast: text-primary meets WCAG AA (>= 4.5:1) against all surfaces", () => {
    const textPrimary = tokens["--text-primary"]!;
    for (const bg of backgrounds) {
      const ratio = contrastRatio(textPrimary, bg.hex);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("contrast: text-secondary meets WCAG AA (>= 4.5:1) against all surfaces", () => {
    const textSecondary = tokens["--text-secondary"]!;
    for (const bg of backgrounds) {
      const ratio = contrastRatio(textSecondary, bg.hex);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("contrast: text-subtle meets WCAG AA (>= 4.5:1) against canvas, surface, and hover", () => {
    const textSubtle = tokens["--text-subtle"]!;
    for (const bg of backgrounds) {
      const ratio = contrastRatio(textSubtle, bg.hex);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("contrast: accent-as-text pairs meet WCAG AA (>= 4.5:1) against all surfaces", () => {
    const accentTextPairs = [
      { name: "--destructive-text", hex: tokens["--destructive-text"]! },
      { name: "--primary", hex: tokens["--primary"]! },
      { name: "--success", hex: tokens["--success"]! },
    ];

    for (const accent of accentTextPairs) {
      for (const bg of backgrounds) {
        const ratio = contrastRatio(accent.hex, bg.hex);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("contrast: button and badge foregrounds meet WCAG AA (>= 4.5:1) against their backgrounds", () => {
    const primaryRatio = contrastRatio(tokens["--primary-fg"]!, tokens["--primary"]!);
    expect(primaryRatio).toBeGreaterThanOrEqual(4.5);

    const destructiveRatio = contrastRatio(
      tokens["--destructive-fg"]!,
      tokens["--destructive"]!
    );
    expect(destructiveRatio).toBeGreaterThanOrEqual(4.5);

    const warningRatio = contrastRatio(tokens["--warning-fg"]!, tokens["--warning"]!);
    expect(warningRatio).toBeGreaterThanOrEqual(4.5);

    const successRatio = contrastRatio(tokens["--success-fg"]!, tokens["--success"]!);
    expect(successRatio).toBeGreaterThanOrEqual(4.5);
  });

  it("contrast: interactive borders and focus rings meet UI contrast (>= 3.0:1)", () => {
    const borderInput = tokens["--border-input"]!;
    for (const bg of backgrounds) {
      const ratio = contrastRatio(borderInput, bg.hex);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    }

    const ring = tokens["--ring"]!;
    for (const bg of backgrounds) {
      const ratio = contrastRatio(ring, bg.hex);
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    }
  });
});
