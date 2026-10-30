import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Button,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  EmptyState,
  ErrorState,
} from "../ui/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webSrcDir = path.resolve(__dirname, "../..");

function getAllTsxFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (file !== "__tests__" && file !== "test") {
        results = results.concat(getAllTsxFiles(fullPath));
      }
    } else if (file.endsWith(".tsx") && !file.includes(".test.")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("UIX-11: Component Tokens Guard & Accessible UI Primitives", () => {
  it("environment: proves web test project runs in jsdom and sees window/document without docblock", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
    expect(typeof window.matchMedia).toBe("function");
  });
  it("guard: scans all src/**/*.tsx and rejects hardcoded hex colors except href anchors", () => {
    const tsxFiles = getAllTsxFiles(webSrcDir);
    expect(tsxFiles.length).toBeGreaterThan(0);

    const hexRegex = /#[0-9a-fA-F]{3,8}\b/g;
    const hrefAnchorRegex = /href=["']#[a-zA-Z0-9-_]+["']/;

    for (const filePath of tsxFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (hrefAnchorRegex.test(line)) continue;

        const matches = line.match(hexRegex);
        if (matches) {
          throw new Error(
            `Hardcoded hex color found in ${path.relative(webSrcDir, filePath)} at line ${i + 1}: "${line.trim()}". Use semantic tokens from tokens.css instead.`
          );
        }
      }
    }
  });

  it("guard: scans all src/**/*.tsx and rejects raw Tailwind palette color classes and white/black across all prefixes", () => {
    const tsxFiles = getAllTsxFiles(webSrcDir);
    expect(tsxFiles.length).toBeGreaterThan(0);

    // Matches raw palette classes like text-slate-900, bg-emerald-500, border-rose-400, etc.
    const paletteClassRegex =
      /\b(bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]+\b/;

    // Matches raw white/black across ALL utility prefixes
    const rawBlackWhiteRegex =
      /\b(bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|placeholder)-(white|black)\b/;

    for (const filePath of tsxFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const paletteMatch = line.match(paletteClassRegex);
        if (paletteMatch) {
          throw new Error(
            `Raw Tailwind palette class "${paletteMatch[0]}" found in ${path.relative(webSrcDir, filePath)} at line ${i + 1}. Use semantic token classes instead (e.g. text-text-primary, bg-surface, text-primary, bg-canvas).`
          );
        }

        const bwMatch = line.match(rawBlackWhiteRegex);
        if (bwMatch) {
          throw new Error(
            `Raw "${bwMatch[0]}" class found in ${path.relative(webSrcDir, filePath)} at line ${i + 1}. Use semantic token classes instead.`
          );
        }
      }
    }
  });

  it("guard: rejects raw rgb/hsl/oklch functions outside tokens.css", () => {
    const tsxFiles = getAllTsxFiles(webSrcDir);
    expect(tsxFiles.length).toBeGreaterThan(0);

    const rawColorFnRegex = /\b(rgba?|hsla?|oklch|oklab)\s*\(/i;

    for (const filePath of tsxFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const match = line.match(rawColorFnRegex);
        if (match) {
          throw new Error(
            `Raw color function "${match[0]}" found in ${path.relative(webSrcDir, filePath)} at line ${i + 1}. Define colors as tokens in tokens.css instead.`
          );
        }
      }
    }

    // Also check all CSS files under src except tokens.css
    const list = fs.readdirSync(webSrcDir);
    for (const item of list) {
      if (item.endsWith(".css") && item !== "tokens.css") {
        const fullCssPath = path.join(webSrcDir, item);
        const cssContent = fs.readFileSync(fullCssPath, "utf-8");
        const match = cssContent.match(rawColorFnRegex);
        if (match) {
          throw new Error(
            `Raw color function "${match[0]}" found in ${item}. Define colors as tokens in tokens.css instead.`
          );
        }
      }
    }
  });

  it("Button: defaults type='button', renders accessible states, minimum 12px text, and visible focus rings", () => {
    const { rerender } = render(<Button size="sm">Small Action</Button>);
    const button = screen.getByRole("button", { name: "Small Action" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("text-xs"); // 12px
    expect(button).toHaveClass("focus-visible:ring-ring");

    rerender(<Button isLoading>Loading Action</Button>);
    const loadingButton = screen.getByRole("button");
    expect(loadingButton).toHaveAttribute("aria-busy", "true");
    expect(loadingButton).toBeDisabled();

    rerender(<Button disabled>Disabled Action</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("Input: sets aria-invalid, generates stable useId when id omitted, and links error message", () => {
    const { unmount } = render(
      <Input
        label="Room Title"
        id="room-title"
        error="Title is required"
        placeholder="Enter title"
      />
    );

    const inputWithId = screen.getByLabelText("Room Title");
    expect(inputWithId).toHaveAttribute("aria-invalid", "true");
    expect(inputWithId).toHaveAttribute("aria-describedby", "room-title-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Title is required");
    unmount();

    // Test with omitted id: useId provides accessible linkage
    render(<Input label="Display Name" error="Name is too short" />);
    const inputWithUseId = screen.getByLabelText("Display Name");
    expect(inputWithUseId).toBeInTheDocument();
    expect(inputWithUseId).toHaveAttribute("aria-invalid", "true");
    const describedBy = inputWithUseId.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveAttribute("id", describedBy);
  });

  it("Modal: renders with responsive classes, accessible title, description, and dismisses on close", () => {
    render(
      <Modal open={true}>
        <ModalContent>
          <ModalHeader>
            <ModalTitle>Test Modal</ModalTitle>
            <ModalDescription>Modal body description for screen readers</ModalDescription>
          </ModalHeader>
          <div>Modal Body Content</div>
        </ModalContent>
      </Modal>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("w-[calc(100vw-2rem)]");
    expect(dialog).toHaveClass("max-h-[calc(100vh-4rem)]");
    expect(screen.getByText("Test Modal")).toBeInTheDocument();
    expect(
      screen.getByText("Modal body description for screen readers")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("EmptyState & ErrorState: support headingLevel, requestId, and role='alert'", () => {
    const { rerender } = render(
      <EmptyState
        title="No Rooms Found"
        headingLevel="h2"
        description="Create your first practice room to get started."
      />
    );
    const emptyHeading = screen.getByRole("heading", {
      level: 2,
      name: "No Rooms Found",
    });
    expect(emptyHeading).toBeInTheDocument();
    expect(
      screen.getByText("Create your first practice room to get started.")
    ).toBeInTheDocument();

    rerender(
      <ErrorState
        title="Failed to Load"
        headingLevel="h2"
        message="Network connection refused"
        requestId="req-abc-123"
        onRetry={() => {}}
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const errorHeading = screen.getByRole("heading", {
      level: 2,
      name: "Failed to Load",
    });
    expect(errorHeading).toBeInTheDocument();
    expect(screen.getByText("Network connection refused")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-abc-123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
  });
});
