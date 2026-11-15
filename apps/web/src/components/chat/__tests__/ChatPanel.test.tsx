import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanel } from "../ChatPanel.js";
import type { ChatMessageItem } from "../../../hooks/useRoomSocket.js";

describe("ChatPanel component", () => {
  const currentUserId = "user-123";
  const onToggleMock = vi.fn();
  const onSendMessageMock = vi.fn().mockResolvedValue("client-msg-1");
  const onRetryMessageMock = vi.fn().mockResolvedValue(undefined);
  const onRefetchHistoryMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleMessages: ChatMessageItem[] = [
    {
      id: "msg-1",
      clientMsgId: "c-1",
      roomId: "room-abc",
      authorId: "user-456",
      authorName: "Alice",
      text: "Hello there!",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    },
    {
      id: "msg-2",
      clientMsgId: "c-2",
      roomId: "room-abc",
      authorId: currentUserId,
      authorName: "Bob",
      text: "Hi Alice, ready to pair!",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    },
  ];

  it("renders closed panel as null", () => {
    const { container } = render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={false}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders open panel with role='log' and messages list", () => {
    render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const log = screen.getByRole("log", { name: /chat messages/i });
    expect(log).toBeInTheDocument();

    expect(screen.getByText("Hello there!")).toBeInTheDocument();
    expect(screen.getByText("Hi Alice, ready to pair!")).toBeInTheDocument();
  });

  it("renders history SILENTLY on mount (no polite announcer output for initial messages)", () => {
    render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const politeAnnouncer = screen.getByTestId("chat-polite-announcer");
    // Initial history must be completely silent
    expect(politeAnnouncer).toHaveTextContent("");
  });

  it("announces newly arrived messages from others, but NEVER announces own messages", () => {
    const { rerender } = render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const politeAnnouncer = screen.getByTestId("chat-polite-announcer");
    expect(politeAnnouncer).toHaveTextContent("");

    // Simulate new message from another user arriving via live event
    const newOtherMessage: ChatMessageItem = {
      id: "msg-3",
      clientMsgId: "c-3",
      roomId: "room-abc",
      authorId: "user-456",
      authorName: "Alice",
      text: "Look at line 42",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    rerender(
      <ChatPanel
        messages={[...sampleMessages, newOtherMessage]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(politeAnnouncer).toHaveTextContent("Alice: Look at line 42");

    // Simulate new message from current user (own message echo)
    const newOwnMessage: ChatMessageItem = {
      id: "msg-4",
      clientMsgId: "c-4",
      roomId: "room-abc",
      authorId: currentUserId,
      authorName: "Bob",
      text: "Checking it now",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    rerender(
      <ChatPanel
        messages={[...sampleMessages, newOtherMessage, newOwnMessage]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    // Announcer retains previous announcement and does NOT announce own message
    expect(politeAnnouncer).toHaveTextContent("Alice: Look at line 42");
  });

  it("renders messages strictly as plain text, preventing HTML/XSS injection", () => {
    const maliciousMessage: ChatMessageItem = {
      id: "msg-xss",
      clientMsgId: "c-xss",
      roomId: "room-abc",
      authorId: "user-999",
      authorName: "Attacker",
      text: '<img src=x onerror=alert(1)> <script>console.log("xss")</script>',
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    render(
      <ChatPanel
        messages={[maliciousMessage]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    // Verified: No <img> or <script> DOM elements are created
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();

    // Plain text is safely displayed on screen
    expect(
      screen.getByText('<img src=x onerror=alert(1)> <script>console.log("xss")</script>')
    ).toBeInTheDocument();
  });

  it("renders system messages with role='status' and distinctive styling", () => {
    const systemMessage: ChatMessageItem = {
      id: "sys-1",
      clientMsgId: "c-sys-1",
      roomId: "room-abc",
      authorId: "system",
      text: "Alice joined the room",
      ts: new Date().toISOString(),
      kind: "system",
      status: "sent",
    };

    render(
      <ChatPanel
        messages={[systemMessage]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const statusEl = screen.getByRole("status");
    expect(statusEl).toBeInTheDocument();
    expect(statusEl).toHaveTextContent("Alice joined the room");
  });

  it("displays sending, sent, and failed states with retry using original clientMsgId", () => {
    const failedMessage: ChatMessageItem = {
      id: "c-pending-99",
      clientMsgId: "c-pending-99",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Failed payload",
      ts: new Date().toISOString(),
      kind: "user",
      status: "failed",
    };

    render(
      <ChatPanel
        messages={[failedMessage]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onRetryMessage={onRetryMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(screen.getByText("Failed to send")).toBeInTheDocument();

    const retryBtn = screen.getByTestId("retry-button-c-pending-99");
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(onRetryMessageMock).toHaveBeenCalledWith("c-pending-99");
  });

  it("renders loading skeletons when isLoadingHistory is true", () => {
    render(
      <ChatPanel
        messages={[]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={true}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(screen.getByTestId("chat-history-skeletons")).toBeInTheDocument();
  });

  it("renders error state with retry button when loadHistoryError is present", () => {
    render(
      <ChatPanel
        messages={[]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onRefetchHistory={onRefetchHistoryMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError="Network timeout fetching history"
        hasEarlierMessages={false}
      />
    );

    expect(screen.getByTestId("chat-history-error")).toBeInTheDocument();
    expect(screen.getByText("Network timeout fetching history")).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryBtn);
    expect(onRefetchHistoryMock).toHaveBeenCalled();
  });

  it("renders empty state when message list is empty", () => {
    render(
      <ChatPanel
        messages={[]}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
  });

  it("displays 'earlier messages not shown' notice when hasEarlierMessages is true", () => {
    render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={true}
      />
    );

    expect(screen.getByTestId("earlier-messages-notice")).toBeInTheDocument();
    expect(
      screen.getByText("Earlier messages not shown (displaying last 200 messages)")
    ).toBeInTheDocument();
  });

  it("closes panel on Escape key press", () => {
    render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const panel = screen.getByTestId("chat-panel");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onToggleMock).toHaveBeenCalledTimes(1);
  });
});
