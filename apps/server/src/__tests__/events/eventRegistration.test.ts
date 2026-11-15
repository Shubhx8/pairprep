import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { z } from "zod";
import {
  attachSocketServer,
  type SocketServerInstance,
} from "../../events/socketServer.js";
import { registerEventHandler, type TypedSocket } from "../../events/eventDispatcher.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { UserModel } from "../../models/users.js";
import { config } from "../../config.js";
import { SESSION_COOKIE_NAME } from "../../middleware/session.js";
import * as sessionPrincipal from "../../auth/sessionPrincipal.js";
import {
  EventErrorCode,
  ObjectIdSchema,
  type EventAck,
  type RoomJoinAckData,
} from "@pairprep/shared";

function signExpressSessionCookie(val: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}

describe("T09 Phase 1 — Reusable Event Registration & Live Event Handling", () => {
  let httpServer: HttpServer | undefined;
  let socketServer: SocketServerInstance | undefined;
  const activeClients: ClientSocket[] = [];

  const validRoomId = "507f1f77bcf86cd799439011";
  const validUserId = "507f1f77bcf86cd799439022";

  const mockRoom = {
    id: validRoomId,
    _id: validRoomId,
    title: "Test Room",
    slug: "ungw83kd92mf74js",
    ownerId: validUserId,
    status: "open",
  };

  const mockMember = {
    id: "507f1f77bcf86cd799439044",
    _id: "507f1f77bcf86cd799439044",
    roomId: validRoomId,
    memberId: validUserId,
    displayName: "Spike User",
    role: "editor",
    isGuest: false,
  };

  beforeAll(() => {
    (config as { SESSION_SECRET?: string }).SESSION_SECRET =
      config.SESSION_SECRET || "test_session_secret_at_least_32_characters_long";
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);

    vi.spyOn(UserModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue({
        id: validUserId,
        disabled: false,
      }),
    } as unknown as never);

    vi.spyOn(RoomModel, "findById").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockRoom),
    } as unknown as never);

    vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
      exec: vi.fn().mockResolvedValue(mockMember),
    } as unknown as never);

    // Default authenticated principal resolver mock
    vi.spyOn(sessionPrincipal, "resolvePrincipalFromCookies").mockResolvedValue({
      success: true,
      principal: {
        type: "user",
        id: validUserId,
        displayName: "Spike User",
        role: "user",
        user: {
          id: validUserId,
          displayName: "Spike User",
          role: "user",
          disabled: false,
        } as unknown as import("../../models/users.js").IUser,
      },
    });
  });

  afterEach(async () => {
    for (const client of activeClients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    activeClients.length = 0;

    if (socketServer) {
      await socketServer.close();
      socketServer = undefined;
    }
    if (httpServer && httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = undefined;
    }
  });

  async function startServer(): Promise<number> {
    httpServer = createServer();
    socketServer = attachSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer!.listen(0, () => resolve()));
    return (httpServer.address() as { port: number }).port;
  }

  function getTestCookieHeader(): string {
    const rawSid = `sid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const cookieVal = signExpressSessionCookie(rawSid, config.SESSION_SECRET!);
    return `${SESSION_COOKIE_NAME}=${cookieVal}`;
  }

  async function connectTestClient(port: number): Promise<ClientSocket> {
    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: "/socket.io",
      transports: ["websocket"],
      extraHeaders: {
        origin: "http://localhost:3000",
        cookie: getTestCookieHeader(),
      },
    });
    activeClients.push(client);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timed out")), 5000);
      client.on("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      client.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return client;
  }

  describe("1. Reusable Event Registration Unit Semantics", () => {
    it("valid payload reaches business handler and returns success acknowledgement", async () => {
      const onMock = vi.fn();
      const mockSocket = {
        data: {
          principal: {
            type: "user",
            id: validUserId,
            displayName: "Spike User",
          },
        },
        on: onMock,
      } as unknown as TypedSocket;

      let handlerCalled = false;
      const testSchema = z.object({ roomId: ObjectIdSchema, count: z.number() }).strict();

      registerEventHandler(mockSocket, {
        name: "test:action",
        schema: testSchema,
        requireRoomAuth: true,
        handler: async (ctx) => {
          handlerCalled = true;
          return { doubled: ctx.payload.count * 2 };
        },
      });

      expect(onMock).toHaveBeenCalledWith("test:action", expect.any(Function));

      // Extract registered listener and invoke with valid payload
      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;
      const ackCallback = vi.fn();

      await registeredListener({ roomId: validRoomId, count: 5 }, ackCallback);

      expect(handlerCalled).toBe(true);
      expect(ackCallback).toHaveBeenCalledWith({
        ok: true,
        data: { doubled: 10 },
      });
    });

    it("invalid payload is rejected with VALIDATION_ERROR and never reaches handler", async () => {
      const onMock = vi.fn();
      const mockSocket = {
        data: {
          principal: { type: "user", id: validUserId },
        },
        on: onMock,
      } as unknown as TypedSocket;

      let handlerCalled = false;
      const testSchema = z.object({ roomId: ObjectIdSchema, text: z.string() }).strict();

      registerEventHandler(mockSocket, {
        name: "test:action",
        schema: testSchema,
        handler: async () => {
          handlerCalled = true;
          return { done: true };
        },
      });

      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;
      const ackCallback = vi.fn();

      // Missing required 'text' field
      await registeredListener({ roomId: validRoomId }, ackCallback);

      expect(handlerCalled).toBe(false);
      expect(ackCallback).toHaveBeenCalledWith({
        ok: false,
        error: expect.objectContaining({
          code: EventErrorCode.VALIDATION_ERROR,
          message: expect.stringMatching(/validation error/i),
        }),
      });
    });

    it("unknown fields are rejected and never reach handler", async () => {
      const onMock = vi.fn();
      const mockSocket = {
        data: {
          principal: { type: "user", id: validUserId },
        },
        on: onMock,
      } as unknown as TypedSocket;

      let handlerCalled = false;
      const testSchema = z.object({ roomId: ObjectIdSchema }).strict();

      registerEventHandler(mockSocket, {
        name: "test:action",
        schema: testSchema,
        handler: async () => {
          handlerCalled = true;
          return { done: true };
        },
      });

      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;
      const ackCallback = vi.fn();

      await registeredListener(
        { roomId: validRoomId, unauthorizedField: "injected" },
        ackCallback
      );

      expect(handlerCalled).toBe(false);
      expect(ackCallback).toHaveBeenCalledWith({
        ok: false,
        error: expect.objectContaining({
          code: EventErrorCode.VALIDATION_ERROR,
        }),
      });
    });

    it("unauthenticated request is rejected with UNAUTHENTICATED", async () => {
      const onMock = vi.fn();
      const mockSocket = {
        data: {}, // No principal
        on: onMock,
      } as unknown as TypedSocket;

      let handlerCalled = false;
      const testSchema = z.object({ roomId: ObjectIdSchema }).strict();

      registerEventHandler(mockSocket, {
        name: "test:action",
        schema: testSchema,
        requireAuth: true,
        handler: async () => {
          handlerCalled = true;
          return { done: true };
        },
      });

      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;
      const ackCallback = vi.fn();

      await registeredListener({ roomId: validRoomId }, ackCallback);

      expect(handlerCalled).toBe(false);
      expect(ackCallback).toHaveBeenCalledWith({
        ok: false,
        error: expect.objectContaining({
          code: EventErrorCode.UNAUTHENTICATED,
          message: expect.stringMatching(/authentication required/i),
        }),
      });
    });

    it("handler exception is safely caught as INTERNAL_ERROR without leaking details", async () => {
      const onMock = vi.fn();
      const mockSocket = {
        id: "sock_12345",
        data: {
          principal: { type: "user", id: validUserId },
        },
        on: onMock,
      } as unknown as TypedSocket;

      const testSchema = z.object({ roomId: ObjectIdSchema }).strict();

      registerEventHandler(mockSocket, {
        name: "test:failing_action",
        schema: testSchema,
        requireRoomAuth: true,
        handler: async () => {
          throw new Error(
            "Secret DB query failed: SELECT * FROM credentials WHERE id=root"
          );
        },
      });

      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;
      const ackCallback = vi.fn();

      await registeredListener({ roomId: validRoomId }, ackCallback);

      expect(ackCallback).toHaveBeenCalledWith({
        ok: false,
        error: {
          code: EventErrorCode.INTERNAL_ERROR,
          message: "An unexpected error occurred while processing your request",
        },
      });
    });

    it("emits room:error when client does not supply an acknowledgement callback", async () => {
      const onMock = vi.fn();
      const emitMock = vi.fn();
      const mockSocket = {
        id: "sock_12345",
        data: {
          principal: { type: "user", id: validUserId },
        },
        on: onMock,
        emit: emitMock,
      } as unknown as TypedSocket;

      const testSchema = z.object({ roomId: ObjectIdSchema }).strict();

      registerEventHandler(mockSocket, {
        name: "test:action",
        schema: testSchema,
        handler: async () => ({ done: true }),
      });

      const registeredListener = onMock.mock.calls[0]?.[1] as (
        payload: unknown,
        ack?: unknown
      ) => Promise<void>;

      // Invoke without ack callback and with invalid payload
      await registeredListener({ roomId: "not-an-objectid" });

      expect(emitMock).toHaveBeenCalledWith(
        "room:error",
        expect.objectContaining({
          code: EventErrorCode.VALIDATION_ERROR,
        })
      );
    });
  });

  describe("2. Live Integration — room:join & room:leave over WebSocket", () => {
    it("client receives successful acknowledgement for valid room:join", async () => {
      const port = await startServer();
      const client = await connectTestClient(port);

      const ack = await new Promise<EventAck<RoomJoinAckData>>((resolve) => {
        client.emit(
          "room:join",
          { roomId: validRoomId },
          (response: EventAck<RoomJoinAckData>) => {
            resolve(response);
          }
        );
      });

      expect(ack.ok).toBe(true);
      if (ack.ok) {
        expect(ack.data.roomId).toBe(validRoomId);
        expect(ack.data.role).toBe("editor");
        expect(ack.data.status).toBe("open");
      }
    });

    it("client receives VALIDATION_ERROR acknowledgement for malformed roomId", async () => {
      const port = await startServer();
      const client = await connectTestClient(port);

      const ack = await new Promise<EventAck>((resolve) => {
        client.emit("room:join", { roomId: "bad-id" }, (response: EventAck) => {
          resolve(response);
        });
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(ack.error.code).toBe(EventErrorCode.VALIDATION_ERROR);
        expect(ack.error.message).toMatch(/validation error/i);
      }
    });

    it("client receives NOT_ROOM_MEMBER acknowledgement if not a member", async () => {
      vi.spyOn(RoomMemberModel, "findOne").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as never);

      const port = await startServer();
      const client = await connectTestClient(port);

      const ack = await new Promise<EventAck>((resolve) => {
        client.emit("room:join", { roomId: validRoomId }, (response: EventAck) => {
          resolve(response);
        });
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(ack.error.code).toBe(EventErrorCode.NOT_ROOM_MEMBER);
        expect(ack.error.message).toMatch(/not an active member/i);
      }
    });

    it("client receives ROOM_NOT_FOUND if room does not exist", async () => {
      vi.spyOn(RoomModel, "findById").mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as unknown as never);

      const port = await startServer();
      const client = await connectTestClient(port);

      const ack = await new Promise<EventAck>((resolve) => {
        client.emit("room:join", { roomId: validRoomId }, (response: EventAck) => {
          resolve(response);
        });
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(ack.error.code).toBe(EventErrorCode.ROOM_NOT_FOUND);
      }
    });

    it("client receives successful acknowledgement for room:leave", async () => {
      const port = await startServer();
      const client = await connectTestClient(port);

      const ack = await new Promise<EventAck<{ roomId: string; left: boolean }>>(
        (resolve) => {
          client.emit(
            "room:leave",
            { roomId: validRoomId },
            (response: EventAck<{ roomId: string; left: boolean }>) => {
              resolve(response);
            }
          );
        }
      );

      expect(ack.ok).toBe(true);
      if (ack.ok) {
        expect(ack.data.roomId).toBe(validRoomId);
        expect(ack.data.left).toBe(true);
      }
    });
  });
});
