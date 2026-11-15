import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RoomPage from "../RoomPage.js";
import { apiClient } from "../../lib/apiClient.js";
import * as authContextModule from "../../lib/authContext.js";
import * as roomSyncModule from "../../hooks/useRoomSync.js";
import type {
  RoomDto,
  PublicRoomDto,
  RoomMemberDetailDto,
  UserPrivateDto,
  MessageDto,
} from "@pairprep/shared";

// Mock CollaborativeEditor to easily inspect readOnly prop
let lastEditorProps: Record<string, unknown> | null = null;
vi.mock("../../components/CollaborativeEditor.js", () => ({
  default: (props: Record<string, unknown>) => {
    lastEditorProps = props;
    return (
      <div data-testid="mock-collaborative-editor" data-readonly={String(props.readOnly)}>
        Collaborative Code Editor Mock (readOnly: {String(props.readOnly)})
      </div>
    );
  },
}));

// Mock socket.io-client
const mockSocket = {
  id: "mock_socket_d1d2",
  connected: false,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
};

const registeredHandlers: Record<string, (...args: unknown[]) => void> = {};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    mockSocket.on.mockImplementation(
      (event: string, handler: (...args: unknown[]) => void) => {
        registeredHandlers[event] = handler;
        return mockSocket;
      }
    );
    mockSocket.off.mockImplementation((event: string) => {
      delete registeredHandlers[event];
      return mockSocket;
    });
    return mockSocket;
  }),
}));

describe("RoomPage Integration — Phase D1 & D2", () => {
  const validRoomId = "507f1f77bcf86cd799439011";
  const mockSlug = "react-algo-room-42";

  const mockRoom: RoomDto = {
    id: validRoomId,
    slug: mockSlug,
    title: "React & Algorithms Practice",
    type: "practice",
    language: "python",
    status: "open",
    ownerId: "usr_alice",
    memberCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const currentMemberAlice: RoomMemberDetailDto = {
    id: "mbr_alice_123",
    displayName: "Alice Dev",
    role: "editor",
    isGuest: false,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };

  const remoteMemberBob: RoomMemberDetailDto = {
    id: "mbr_bob_456",
    displayName: "Bob Coder",
    role: "editor",
    isGuest: false,
    joinedAt: "2026-01-01T00:01:00.000Z",
  };

  function triggerSocket(event: string, ...args: unknown[]) {
    const handler = registeredHandlers[event];
    if (handler) {
      act(() => {
        handler(...args);
      });
    }
  }

  async function waitForSocketRegistration() {
    for (let i = 0; i < 50; i++) {
      if (registeredHandlers["connect"]) return;
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const mockUseAuth = (user: UserPrivateDto | null) => {
    vi.spyOn(authContextModule, "useAuth").mockReturnValue({
      user,
      status: user ? "authenticated" : "anonymous",
      isLoading: false,
      isAuthenticated: Boolean(user),
      login: vi.fn(),
      logout: vi.fn(),
      refreshMe: vi.fn(),
    });
  };

  const renderWithRoute = (slug = mockSlug) => {
    return render(
      <MemoryRouter initialEntries={[`/r/${slug}`]}>
        <Routes>
          <Route path="/r/:slug" element={<RoomPage />} />
          <Route path="/dashboard" element={<div>Mock Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastEditorProps = null;
    mockSocket.connected = false;
    Object.keys(registeredHandlers).forEach((k) => delete registeredHandlers[k]);

    mockUseAuth({
      id: "usr_alice",
      provider: "github",
      displayName: "Alice Dev",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      email: "alice@example.com",
    });

    vi.spyOn(roomSyncModule, "useRoomSync").mockReturnValue({
      doc: null,
      provider: null,
      status: "connected",
      isSynced: true,
      error: null,
    });

    vi.spyOn(apiClient, "get").mockImplementation(async (url: string) => {
      if (url.includes("/messages")) {
        return { messages: [], nextCursor: null, hasMore: false };
      }
      return {
        room: mockRoom,
        currentMember: currentMemberAlice,
        members: [currentMemberAlice, remoteMemberBob],
        onlineMemberCount: 2,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* -------------------------------------------------------------------------- */
  /* PHASE D1: ROOMPAGE INTEGRATION & CHAT PANEL                                */
  /* -------------------------------------------------------------------------- */

  describe("Phase D1: Chat Trigger, Panel, and Connection Mounting", () => {
    it("renders the ChatTriggerButton in the room header for active members", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("chat-trigger-button")).toBeInTheDocument();
      });

      const triggerBtn = screen.getByTestId("chat-trigger-button");
      expect(triggerBtn).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("chat-unread-badge")).toBeNull();
    });

    it("opens and closes the ChatPanel when trigger button is toggled", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("chat-trigger-button")).toBeInTheDocument();
      });

      const triggerBtn = screen.getByTestId("chat-trigger-button");

      // Open chat panel
      fireEvent.click(triggerBtn);

      await waitFor(() => {
        expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
      });
      expect(triggerBtn).toHaveAttribute("aria-expanded", "true");

      // Close chat panel via trigger button
      fireEvent.click(triggerBtn);

      await waitFor(() => {
        expect(screen.queryByTestId("chat-panel")).toBeNull();
      });
      expect(triggerBtn).toHaveAttribute("aria-expanded", "false");
    });

    it("displays unread badge on trigger when messages arrive while closed and clears upon opening", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("chat-trigger-button")).toBeInTheDocument();
      });

      await waitForSocketRegistration();

      // Connect socket
      act(() => {
        mockSocket.connected = true;
      });
      triggerSocket("connect");

      // Receive a message from Bob while ChatPanel is closed
      const incomingMsg: MessageDto = {
        id: "msg_bob_1",
        seq: 1,
        roomId: validRoomId,
        authorId: "mbr_bob_456",
        clientMsgId: "c_bob_1",
        text: "Hello Alice! Ready to pair?",
        kind: "user",
        ts: new Date().toISOString(),
      };

      triggerSocket("chat:message", { roomId: validRoomId, message: incomingMsg });

      // Unread badge should now appear on the trigger button
      await waitFor(() => {
        expect(screen.getByTestId("chat-unread-badge")).toBeInTheDocument();
        expect(screen.getByTestId("chat-unread-badge")).toHaveTextContent("1");
      });

      // Opening chat clears unread count
      const triggerBtn = screen.getByTestId("chat-trigger-button");
      fireEvent.click(triggerBtn);

      await waitFor(() => {
        expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
        expect(screen.queryByTestId("chat-unread-badge")).toBeNull();
      });
    });

    it("does NOT initialize useRoomSocket for unjoined/anonymous visitors", async () => {
      mockUseAuth(null);
      const publicRoom: PublicRoomDto = {
        slug: mockSlug,
        title: "React & Algorithms Practice",
        type: "practice",
        language: "python",
        status: "open",
        memberCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      vi.spyOn(apiClient, "get").mockResolvedValue({
        room: publicRoom,
        currentMember: undefined,
      });

      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByText("Join as Guest")).toBeInTheDocument();
      });

      // Chat trigger button must not exist on the join/preview screen
      expect(screen.queryByTestId("chat-trigger-button")).toBeNull();
      expect(mockSocket.connect).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------------------------------------- */
  /* PHASE D2: PARTICIPANT EVENTS & LIFECYCLE                                    */
  /* -------------------------------------------------------------------------- */

  describe("Phase D2: Live Participant Events & Lifecycle Handling", () => {
    it("updates member role and sets Monaco readOnly dynamically when role changes", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("mock-collaborative-editor")).toBeInTheDocument();
      });

      // Initially editor is writable (readOnly: false)
      expect(lastEditorProps?.readOnly).toBe(false);

      await waitForSocketRegistration();

      // Simulate room:role_changed to 'viewer' for current member Alice
      triggerSocket("room:role_changed", {
        roomId: validRoomId,
        memberId: currentMemberAlice.id,
        role: "viewer",
      });

      // CollaborativeEditor readOnly must now be true
      await waitFor(() => {
        expect(lastEditorProps?.readOnly).toBe(true);
      });

      // Simulate room:role_changed back to 'editor'
      triggerSocket("room:role_changed", {
        roomId: validRoomId,
        memberId: currentMemberAlice.id,
        role: "editor",
      });

      await waitFor(() => {
        expect(lastEditorProps?.readOnly).toBe(false);
      });
    });

    it("handles room:member_left(reason: 'removed') for current member: cleans up and shows removed screen", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("mock-collaborative-editor")).toBeInTheDocument();
      });

      await waitForSocketRegistration();

      // Simulate removal of current member
      triggerSocket("room:member_left", {
        roomId: validRoomId,
        memberId: currentMemberAlice.id,
        reason: "removed",
      });

      await waitFor(() => {
        expect(screen.getByTestId("removed-screen")).toBeInTheDocument();
      });

      expect(screen.getByText("Removed from Room")).toBeInTheDocument();
      expect(
        screen.getByText("You have been removed from this room by the host.")
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to Dashboard" })).toBeInTheDocument();
    });

    it("handles remote member leaving by updating participants list", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(
          screen.getByTestId(`participant-${remoteMemberBob.id}`)
        ).toBeInTheDocument();
      });

      await waitForSocketRegistration();

      // Remote member Bob leaves
      triggerSocket("room:member_left", {
        roomId: validRoomId,
        memberId: remoteMemberBob.id,
        reason: "departed",
      });

      await waitFor(() => {
        expect(screen.queryByTestId(`participant-${remoteMemberBob.id}`)).toBeNull();
      });
    });

    it("handles remote member joining by updating participants list", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(
          screen.getByTestId(`participant-${currentMemberAlice.id}`)
        ).toBeInTheDocument();
      });

      await waitForSocketRegistration();

      // New member Charlie joins
      triggerSocket("room:member_joined", {
        roomId: validRoomId,
        member: {
          memberId: "mbr_charlie_789",
          displayName: "Charlie New",
          role: "editor",
          isGuest: false,
          joinedAt: new Date().toISOString(),
        },
      });

      await waitFor(() => {
        expect(screen.getByTestId("participant-mbr_charlie_789")).toBeInTheDocument();
        expect(screen.getByText("Charlie New")).toBeInTheDocument();
      });
    });

    it("handles room:status_changed(status: 'ended'): shows banner, disables chat composer, editor readOnly, retains code & history", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("mock-collaborative-editor")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("room-ended-banner")).toBeNull();
      expect(lastEditorProps?.readOnly).toBe(false);

      await waitForSocketRegistration();

      // End room
      triggerSocket("room:status_changed", {
        roomId: validRoomId,
        status: "ended",
      });

      await waitFor(() => {
        expect(screen.getByTestId("room-ended-banner")).toBeInTheDocument();
      });

      // Editor becomes readOnly
      expect(lastEditorProps?.readOnly).toBe(true);
      // Collaborative editor is STILL mounted with code visible
      expect(screen.getByTestId("mock-collaborative-editor")).toBeInTheDocument();

      // Open chat and check composer disabled state
      const triggerBtn = screen.getByTestId("chat-trigger-button");
      fireEvent.click(triggerBtn);

      await waitFor(() => {
        expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
      });

      const composer = screen.getByTestId("chat-composer-textarea");
      expect(composer).toBeDisabled();
      expect(screen.getByText("Room has ended. Chat is view-only.")).toBeInTheDocument();
    });

    it("handles room:deleted: terminates connections and shows deleted screen", async () => {
      renderWithRoute();

      await waitFor(() => {
        expect(screen.getByTestId("mock-collaborative-editor")).toBeInTheDocument();
      });

      await waitForSocketRegistration();

      // Trigger room:deleted
      triggerSocket("room:deleted", {
        roomId: validRoomId,
      });

      await waitFor(() => {
        expect(screen.getByTestId("deleted-screen")).toBeInTheDocument();
      });

      expect(screen.getByText("Room Deleted")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to Dashboard" })).toBeInTheDocument();
    });
  });
});
