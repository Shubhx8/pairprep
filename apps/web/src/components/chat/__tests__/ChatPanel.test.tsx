import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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

  it("renders unread badge when ChatPanel is collapsed and new messages arrive from others", () => {
    const onUnreadCountChangeMock = vi.fn();
    const { rerender } = render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={false}
        renderCollapsedTrigger={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onUnreadCountChange={onUnreadCountChangeMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    // Initial mount with history is silent, no unread badge
    expect(screen.queryByTestId("chat-unread-badge")).toBeNull();

    // New message from another user arrives while collapsed
    const incoming1: ChatMessageItem = {
      id: "msg-unread-1",
      clientMsgId: "c-unread-1",
      roomId: "room-abc",
      authorId: "user-456",
      authorName: "Alice",
      text: "Unread message 1",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    rerender(
      <ChatPanel
        messages={[...sampleMessages, incoming1]}
        currentUserId={currentUserId}
        isOpen={false}
        renderCollapsedTrigger={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onUnreadCountChange={onUnreadCountChangeMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    const badge = screen.getByTestId("chat-unread-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("1");
    expect(onUnreadCountChangeMock).toHaveBeenCalledWith(1);

    // Second message arrives from another user
    const incoming2: ChatMessageItem = {
      id: "msg-unread-2",
      clientMsgId: "c-unread-2",
      roomId: "room-abc",
      authorId: "user-456",
      authorName: "Alice",
      text: "Unread message 2",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    rerender(
      <ChatPanel
        messages={[...sampleMessages, incoming1, incoming2]}
        currentUserId={currentUserId}
        isOpen={false}
        renderCollapsedTrigger={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onUnreadCountChange={onUnreadCountChangeMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(badge).toHaveTextContent("2");
    expect(onUnreadCountChangeMock).toHaveBeenCalledWith(2);

    // When panel is opened, unread count resets to 0
    rerender(
      <ChatPanel
        messages={[...sampleMessages, incoming1, incoming2]}
        currentUserId={currentUserId}
        isOpen={true}
        renderCollapsedTrigger={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onUnreadCountChange={onUnreadCountChangeMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(onUnreadCountChangeMock).toHaveBeenCalledWith(0);
  });

  it("manages focus: focuses composer input when opened and restores focus to trigger on close", async () => {
    vi.useFakeTimers();
    const triggerButton = document.createElement("button");
    document.body.appendChild(triggerButton);
    const triggerRef = { current: triggerButton };

    const { rerender } = render(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={true}
        triggerRef={triggerRef}
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

    // Focus timer elapses
    vi.advanceTimersByTime(100);
    const textarea = screen.getByLabelText(/send a message/i);
    expect(document.activeElement).toBe(textarea);

    // Escape closes panel and focuses trigger
    const panel = screen.getByTestId("chat-panel");
    const focusSpy = vi.spyOn(triggerButton, "focus");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onToggleMock).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();

    // Close button also restores focus
    const closeBtn = screen.getByTestId("chat-panel-close-button");
    fireEvent.click(closeBtn);
    expect(focusSpy).toHaveBeenCalledTimes(2);

    // Transitioning isOpen to false restores focus
    rerender(
      <ChatPanel
        messages={sampleMessages}
        currentUserId={currentUserId}
        isOpen={false}
        triggerRef={triggerRef}
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
    expect(focusSpy).toHaveBeenCalledTimes(3);

    triggerButton.remove();
    vi.useRealTimers();
  });

  it("traps focus within chat panel on Tab and Shift+Tab keydown", () => {
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
    const closeBtn = screen.getByTestId("chat-panel-close-button");
    const textarea = screen.getByLabelText(/send a message/i);

    // Initial state: closeBtn is first focusable element
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab from first element wraps to last focusable element (textarea when empty)
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(textarea);

    // Tab from last element wraps to first focusable element (close button)
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    // Now type text into composer so Send button becomes enabled and focusable
    fireEvent.change(textarea, { target: { value: "Hello world" } });
    const sendBtn = screen.getByTestId("chat-composer-send-button");
    expect(sendBtn).not.toBeDisabled();

    // Focus on send button (now the last focusable element)
    sendBtn.focus();
    expect(document.activeElement).toBe(sendBtn);

    // Tab from send button wraps to close button
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab from close button wraps to send button
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(sendBtn);
  });

  it("visually distinguishes system messages from user messages", () => {
    const mixedMessages: ChatMessageItem[] = [
      {
        id: "sys-joined",
        clientMsgId: "c-sys-j",
        roomId: "room-abc",
        authorId: "system",
        text: "User Alice joined room",
        ts: new Date().toISOString(),
        kind: "system",
        status: "sent",
      },
      {
        id: "user-msg",
        clientMsgId: "c-user-1",
        roomId: "room-abc",
        authorId: "user-456",
        authorName: "Alice",
        text: "Hello everyone",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
      },
      {
        id: "own-msg",
        clientMsgId: "c-own-1",
        roomId: "room-abc",
        authorId: currentUserId,
        authorName: "Bob",
        text: "Welcome Alice!",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
      },
    ];

    render(
      <ChatPanel
        messages={mixedMessages}
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

    // System message has role="status" and is centered without user bubble attributes
    const systemEl = screen.getByRole("status");
    expect(systemEl).toHaveTextContent("User Alice joined room");
    expect(systemEl).toHaveClass("flex justify-center");
    expect(systemEl).not.toHaveAttribute("data-author");

    // Other user message has data-author="other" and left-aligned container
    const otherMsg = screen.getByTestId("chat-message-user-msg");
    expect(otherMsg).toHaveAttribute("data-author", "other");
    expect(otherMsg).toHaveClass("mr-auto items-start");
    expect(otherMsg).toHaveTextContent("Alice");

    // Own user message has data-author="own" and right-aligned container
    const ownMsg = screen.getByTestId("chat-message-own-msg");
    expect(ownMsg).toHaveAttribute("data-author", "own");
    expect(ownMsg).toHaveClass("ml-auto items-end");
    expect(ownMsg).toHaveTextContent("You");
  });

  it("displays new-messages pill when user is scrolled up and scrolls to bottom on click", () => {
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

    // Initial state: not scrolled up, no pill
    expect(screen.queryByTestId("new-messages-pill")).toBeNull();

    // User scrolls up (scrollTop is far from bottom)
    const logArea = screen.getByRole("log", { name: /chat messages/i });
    Object.defineProperty(logArea, "scrollHeight", { value: 1200, configurable: true });
    Object.defineProperty(logArea, "scrollTop", { value: 200, configurable: true });
    Object.defineProperty(logArea, "clientHeight", { value: 300, configurable: true });
    // Distance to bottom = 1200 - 200 - 300 = 700px (> 80px)
    fireEvent.scroll(logArea);

    // New message arrives from other user while scrolled up
    const newMsg: ChatMessageItem = {
      id: "msg-pill-test",
      clientMsgId: "c-pill-1",
      roomId: "room-abc",
      authorId: "user-456",
      authorName: "Alice",
      text: "Look at this while scrolled up",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
    };

    rerender(
      <ChatPanel
        messages={[...sampleMessages, newMsg]}
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

    // New messages pill is now visible!
    const pill = screen.getByTestId("new-messages-pill");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent("New messages");

    // Clicking the pill scrolls to bottom and dismisses the pill
    fireEvent.click(pill);
    expect(screen.queryByTestId("new-messages-pill")).toBeNull();
  });

  it("renders WhatsApp single tick (✓) for own message when pending delivery", () => {
    const sentMsg: ChatMessageItem = {
      id: "msg-offline-1",
      clientMsgId: "c-off-1",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Hello offline peer",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
      deliveredTo: [],
      readBy: [],
    };

    render(
      <ChatPanel
        messages={[sentMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer" },
        ]}
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

    const singleTick = screen.getByTestId("tick-single-msg-offline-1");
    expect(singleTick).toBeInTheDocument();
    expect(singleTick).toHaveAttribute("aria-label", "Sent");
    expect(screen.queryByTestId("tick-read-msg-offline-1")).toBeNull();
    expect(screen.queryByTestId("tick-delivered-msg-offline-1")).toBeNull();
  });

  it("renders WhatsApp double grey tick (✓✓) when recipient acknowledges delivery", () => {
    const deliveredMsg: ChatMessageItem = {
      id: "msg-del-1",
      clientMsgId: "c-del-1",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Delivered to peer",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
      deliveredTo: ["peer-1"],
      readBy: [],
    };

    render(
      <ChatPanel
        messages={[deliveredMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer" },
        ]}
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

    const deliveredTick = screen.getByTestId("tick-delivered-msg-del-1");
    expect(deliveredTick).toBeInTheDocument();
    expect(deliveredTick).toHaveAttribute("aria-label", "Delivered");
    expect(screen.queryByTestId("tick-read-msg-del-1")).toBeNull();
  });

  it("renders WhatsApp double blue tick when recipient acknowledges read", () => {
    const ownMsg: ChatMessageItem = {
      id: "msg-read-1",
      clientMsgId: "c-read-1",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Are you ready?",
      ts: new Date(Date.now() - 5000).toISOString(),
      kind: "user",
      status: "sent",
      deliveredTo: ["peer-1"],
      readBy: ["peer-1"],
    };

    render(
      <ChatPanel
        messages={[ownMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer" },
        ]}
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

    const readTick = screen.getByTestId("tick-read-msg-read-1");
    expect(readTick).toBeInTheDocument();
    expect(readTick).toHaveAttribute("aria-label", "Read");
  });

  it("triggers onMarkMessageRead when unread peer message is presented in open chat panel", () => {
    const onMarkMessageReadMock = vi.fn();
    const peerMsg: ChatMessageItem = {
      id: "msg-incoming-1",
      clientMsgId: "c-inc-1",
      roomId: "room-abc",
      authorId: "peer-1",
      authorName: "Bob",
      seq: 42,
      text: "Hey there!",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
      deliveredTo: [],
      readBy: [],
    };

    render(
      <ChatPanel
        messages={[peerMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer" },
        ]}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onMarkMessageRead={onMarkMessageReadMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(onMarkMessageReadMock).toHaveBeenCalledWith("msg-incoming-1", 42);
  });

  it("does NOT trigger onMarkMessageRead when chat panel is closed", () => {
    const onMarkMessageReadMock = vi.fn();
    const peerMsg: ChatMessageItem = {
      id: "msg-closed-1",
      clientMsgId: "c-closed-1",
      roomId: "room-abc",
      authorId: "peer-1",
      authorName: "Bob",
      seq: 43,
      text: "Unread while closed",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
      deliveredTo: [],
      readBy: [],
    };

    render(
      <ChatPanel
        messages={[peerMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer" },
        ]}
        isOpen={false}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onMarkMessageRead={onMarkMessageReadMock}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    expect(onMarkMessageReadMock).not.toHaveBeenCalled();
  });

  it("does NOT trigger onMarkMessageRead when browser tab is hidden in background", () => {
    const onMarkMessageReadMock = vi.fn();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });

    try {
      const peerMsg: ChatMessageItem = {
        id: "msg-hidden-1",
        clientMsgId: "c-hidden-1",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 44,
        text: "Unread while hidden",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      expect(onMarkMessageReadMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "visibilityState", {
        value: originalVisibility,
        configurable: true,
      });
    }
  });

  it("does NOT trigger onMarkMessageRead when browser window is not focused", () => {
    const onMarkMessageReadMock = vi.fn();
    const originalHasFocus = document.hasFocus;
    document.hasFocus = vi.fn().mockReturnValue(false);

    try {
      const peerMsg: ChatMessageItem = {
        id: "msg-unfocused-1",
        clientMsgId: "c-unf-1",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 45,
        text: "Unread while unfocused",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      expect(onMarkMessageReadMock).not.toHaveBeenCalled();
    } finally {
      document.hasFocus = originalHasFocus;
    }
  });

  it("group semantics: displays single tick until all eligible recipients have received message", () => {
    const groupMsg: ChatMessageItem = {
      id: "msg-group-1",
      clientMsgId: "c-grp-1",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Notice to all 3 peers",
      ts: new Date().toISOString(),
      kind: "user",
      status: "sent",
      recipientIds: ["peer-1", "peer-2"],
      deliveredTo: ["peer-1"], // only 1 of 2 delivered
      readBy: [],
    };

    render(
      <ChatPanel
        messages={[groupMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer 1" },
          { id: "peer-2", displayName: "Peer 2" },
        ]}
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

    // Should remain single tick because peer-2 hasn't acknowledged delivery yet
    expect(screen.getByTestId("tick-single-msg-group-1")).toBeInTheDocument();
    expect(screen.queryByTestId("tick-delivered-msg-group-1")).toBeNull();
  });

  it("retroactive safety: new member joining does NOT revert older message double blue ticks", () => {
    // Message was created when only peer-1 existed in the room
    const pastMsg: ChatMessageItem = {
      id: "msg-past-1",
      clientMsgId: "c-past-1",
      roomId: "room-abc",
      authorId: currentUserId,
      text: "Older message viewed by original peer",
      ts: new Date(Date.now() - 60000).toISOString(),
      kind: "user",
      status: "sent",
      recipientIds: ["peer-1"], // recipient eligibility fixed at message creation
      deliveredTo: ["peer-1"],
      readBy: ["peer-1"],
    };

    render(
      <ChatPanel
        messages={[pastMsg]}
        currentUserId={currentUserId}
        roomMembers={[
          { id: currentUserId, displayName: "Self" },
          { id: "peer-1", displayName: "Peer 1" },
          { id: "peer-new", displayName: "New Peer Joined Later" }, // joined after message was sent
        ]}
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

    // Remains double blue tick because peer-1 was the only eligible recipient when sent
    const readTick = screen.getByTestId("tick-read-msg-past-1");
    expect(readTick).toBeInTheDocument();
  });

  it("Phase 14: re-evaluates and marks visible unread messages on 5s idle interval", () => {
    vi.useFakeTimers();
    try {
      const onMarkMessageReadMock = vi.fn();
      const peerMsg: ChatMessageItem = {
        id: "msg-idle-retry-1",
        clientMsgId: "c-idle-1",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 99,
        text: "Idle retry test",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      // Initial render marked it
      expect(onMarkMessageReadMock).toHaveBeenCalledTimes(1);
      expect(onMarkMessageReadMock).toHaveBeenCalledWith("msg-idle-retry-1", 99);

      // Advance time by 5s idle interval
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // The 5s interval triggered retry evaluation
      expect(onMarkMessageReadMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Phase 15: does NOT mark message read when element is clipped outside container bounds", () => {
    vi.useFakeTimers();
    try {
      const onMarkMessageReadMock = vi.fn();
      const peerMsg: ChatMessageItem = {
        id: "msg-clipped-1",
        clientMsgId: "c-clip-1",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 100,
        text: "Clipped message",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      const { container } = render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      onMarkMessageReadMock.mockClear();

      // Mock scroll container rect to 300x400 at (0, 0)
      const scrollContainer = container.querySelector(
        "[data-testid='chat-messages-log']"
      ) as HTMLElement | null;
      const msgElement = container.querySelector(
        "[data-message-id='msg-clipped-1']"
      ) as HTMLElement | null;

      expect(scrollContainer).not.toBeNull();
      expect(msgElement).not.toBeNull();

      if (scrollContainer && msgElement) {
        vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue({
          top: 0,
          bottom: 400,
          left: 0,
          right: 300,
          width: 300,
          height: 400,
          x: 0,
          y: 0,
          toJSON: () => {},
        });

        // Message is positioned vertically outside (top: 500, bottom: 600)
        vi.spyOn(msgElement, "getBoundingClientRect").mockReturnValue({
          top: 500,
          bottom: 600,
          left: 0,
          right: 300,
          width: 300,
          height: 100,
          x: 0,
          y: 500,
          toJSON: () => {},
        });

        // Trigger 5s interval check
        act(() => {
          vi.advanceTimersByTime(5000);
        });

        // Must NOT mark read because it is clipped out of the viewport
        expect(onMarkMessageReadMock).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("Phase 15: cleans up idle retry interval upon unmount", () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(
      <ChatPanel
        messages={[]}
        currentUserId={currentUserId}
        roomMembers={[{ id: currentUserId, displayName: "Self" }]}
        isOpen={true}
        onToggle={onToggleMock}
        onSendMessage={onSendMessageMock}
        onMarkMessageRead={vi.fn()}
        connectionStatus="connected"
        isRateLimited={false}
        rateLimitCountdown={0}
        isRoomEnded={false}
        isLoadingHistory={false}
        loadHistoryError={null}
        hasEarlierMessages={false}
      />
    );

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("Phase 17: does NOT mark message read when only 10% of message is visible (under 50% threshold)", () => {
    vi.useFakeTimers();
    try {
      const onMarkMessageReadMock = vi.fn();
      const peerMsg: ChatMessageItem = {
        id: "msg-partial-10",
        clientMsgId: "c-part-10",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 101,
        text: "Partially visible message",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      const { container } = render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      onMarkMessageReadMock.mockClear();

      const scrollContainer = container.querySelector(
        "[data-testid='chat-messages-log']"
      ) as HTMLElement | null;
      const msgElement = container.querySelector(
        "[data-message-id='msg-partial-10']"
      ) as HTMLElement | null;

      expect(scrollContainer).not.toBeNull();
      expect(msgElement).not.toBeNull();

      if (scrollContainer && msgElement) {
        // Container: 300x400 (top: 0, bottom: 400)
        vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue({
          top: 0,
          bottom: 400,
          left: 0,
          right: 300,
          width: 300,
          height: 400,
          x: 0,
          y: 0,
          toJSON: () => {},
        });

        // Message: height 100px (top: 390, bottom: 490). Only 10px (top: 390 to 400) inside container = 10% visible
        vi.spyOn(msgElement, "getBoundingClientRect").mockReturnValue({
          top: 390,
          bottom: 490,
          left: 0,
          right: 300,
          width: 300,
          height: 100,
          x: 0,
          y: 390,
          toJSON: () => {},
        });

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(onMarkMessageReadMock).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("Phase 17: DOES mark message read when 60% of message is visible (exceeds 50% threshold)", () => {
    vi.useFakeTimers();
    try {
      const onMarkMessageReadMock = vi.fn();
      const peerMsg: ChatMessageItem = {
        id: "msg-partial-60",
        clientMsgId: "c-part-60",
        roomId: "room-abc",
        authorId: "peer-1",
        authorName: "Bob",
        seq: 102,
        text: "60% visible message",
        ts: new Date().toISOString(),
        kind: "user",
        status: "sent",
        deliveredTo: [],
        readBy: [],
      };

      const { container } = render(
        <ChatPanel
          messages={[peerMsg]}
          currentUserId={currentUserId}
          roomMembers={[
            { id: currentUserId, displayName: "Self" },
            { id: "peer-1", displayName: "Peer" },
          ]}
          isOpen={true}
          onToggle={onToggleMock}
          onSendMessage={onSendMessageMock}
          onMarkMessageRead={onMarkMessageReadMock}
          connectionStatus="connected"
          isRateLimited={false}
          rateLimitCountdown={0}
          isRoomEnded={false}
          isLoadingHistory={false}
          loadHistoryError={null}
          hasEarlierMessages={false}
        />
      );

      onMarkMessageReadMock.mockClear();

      const scrollContainer = container.querySelector(
        "[data-testid='chat-messages-log']"
      ) as HTMLElement | null;
      const msgElement = container.querySelector(
        "[data-message-id='msg-partial-60']"
      ) as HTMLElement | null;

      expect(scrollContainer).not.toBeNull();
      expect(msgElement).not.toBeNull();

      if (scrollContainer && msgElement) {
        // Container: 300x400 (top: 0, bottom: 400)
        vi.spyOn(scrollContainer, "getBoundingClientRect").mockReturnValue({
          top: 0,
          bottom: 400,
          left: 0,
          right: 300,
          width: 300,
          height: 400,
          x: 0,
          y: 0,
          toJSON: () => {},
        });

        // Message: height 100px (top: 340, bottom: 440). 60px (top: 340 to 400) inside container = 60% visible
        vi.spyOn(msgElement, "getBoundingClientRect").mockReturnValue({
          top: 340,
          bottom: 440,
          left: 0,
          right: 300,
          width: 300,
          height: 100,
          x: 0,
          y: 340,
          toJSON: () => {},
        });

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(onMarkMessageReadMock).toHaveBeenCalledWith("msg-partial-60", 102);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
