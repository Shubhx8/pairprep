import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatComposer, countGraphemes, countBytes } from "../ChatComposer.js";

describe("ChatComposer helper functions", () => {
  it("accurately counts grapheme clusters with Intl.Segmenter", () => {
    expect(countGraphemes("")).toBe(0);
    expect(countGraphemes("hello")).toBe(5);
    // Multi-codepoint emoji: woman technologist "👩‍💻" is 1 grapheme cluster (5 code points)
    expect(countGraphemes("👩‍💻")).toBe(1);
    // Flag: 🇺🇸 is 1 grapheme cluster (2 regional indicator symbols)
    expect(countGraphemes("🇺🇸")).toBe(1);
    expect(countGraphemes("Hello 🌍!")).toBe(8);
  });

  it("accurately counts UTF-8 bytes with TextEncoder", () => {
    expect(countBytes("")).toBe(0);
    expect(countBytes("abc")).toBe(3);
    // '€' is 3 bytes in UTF-8
    expect(countBytes("€")).toBe(3);
    // '🚀' is 4 bytes in UTF-8
    expect(countBytes("🚀")).toBe(4);
  });
});

describe("ChatComposer component", () => {
  const onSendMessageMock = vi.fn().mockResolvedValue("msg-123");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders textarea with accessible label and counter", () => {
    render(<ChatComposer onSendMessage={onSendMessageMock} />);

    const textarea = screen.getByLabelText(/send a message/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-label", "Send a message");

    const counter = screen.getByTestId("chat-composer-counter");
    expect(counter).toHaveTextContent("0 / 1,000");

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();
  });

  it("updates live counter as user types and enables send button", async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSendMessage={onSendMessageMock} />);

    const textarea = screen.getByLabelText(/send a message/i);
    await user.type(textarea, "Hello peer!");

    const counter = screen.getByTestId("chat-composer-counter");
    expect(counter).toHaveTextContent("11 / 1,000");

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeEnabled();
  });

  it("sends message on Enter key and clears textarea", async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSendMessage={onSendMessageMock} />);

    const textarea = screen.getByLabelText(/send a message/i);
    await user.type(textarea, "Hello world{Enter}");

    expect(onSendMessageMock).toHaveBeenCalledWith("Hello world");
    await waitFor(() => {
      expect(textarea).toHaveValue("");
    });
  });

  it("does not send on Shift+Enter (allows newline insertion)", async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSendMessage={onSendMessageMock} />);

    const textarea = screen.getByLabelText(/send a message/i);
    await user.type(textarea, "Line 1{Shift>}{Enter}{/Shift}Line 2");

    expect(onSendMessageMock).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Line 1\nLine 2");
  });

  it("prevents sending when exceeding 1,000 graphemes", async () => {
    render(<ChatComposer onSendMessage={onSendMessageMock} />);

    const textarea = screen.getByLabelText(/send a message/i);
    const longText = "a".repeat(1005);
    fireEvent.change(textarea, { target: { value: longText } });

    const counter = screen.getByTestId("chat-composer-counter");
    expect(counter).toHaveTextContent("1,005 / 1,000");

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();

    // Attempt Enter key
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSendMessageMock).not.toHaveBeenCalled();
  });

  it("shows rate-limit countdown banner and disables composer", () => {
    render(
      <ChatComposer
        onSendMessage={onSendMessageMock}
        isRateLimited={true}
        rateLimitCountdown={8}
      />
    );

    const banner = screen.getByTestId("rate-limit-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(
      "Rate limited. Please wait 8s before sending again."
    );

    const textarea = screen.getByLabelText(/send a message/i);
    expect(textarea).toBeDisabled();

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();
  });

  it("shows disabled banner when disabled reason provided (e.g. room ended)", () => {
    render(
      <ChatComposer
        onSendMessage={onSendMessageMock}
        disabled={true}
        disabledReason="Room has ended. Chat is view-only."
      />
    );

    const banner = screen.getByTestId("composer-disabled-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Room has ended. Chat is view-only.");

    const textarea = screen.getByLabelText(/send a message/i);
    expect(textarea).toBeDisabled();
  });
});
