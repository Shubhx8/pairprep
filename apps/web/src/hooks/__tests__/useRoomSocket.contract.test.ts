import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { io as createClientSocket, type Socket as ClientSocket } from "socket.io-client";

describe("Socket.IO Real Transport & Reconnection Contract (v4.8.4)", () => {
  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let port: number;
  let serverUrl: string;

  let shouldRejectHandshake = false;

  beforeAll(async () => {
    httpServer = http.createServer();
    ioServer = new SocketIOServer(httpServer, {
      path: "/socket.io",
      transports: ["websocket"],
      cors: { origin: "*" },
    });

    // Handshake middleware that can conditionally reject
    ioServer.use((_socket, next) => {
      if (shouldRejectHandshake) {
        return next(new Error("Unauthorized origin"));
      }
      next();
    });

    // In-memory test event handler simulating the PairPrep server contract
    ioServer.on("connection", (socket) => {
      socket.on(
        "room:join",
        (payload: { roomId: string }, ack?: (res: unknown) => void) => {
          socket.join(`room:${payload.roomId}`);
          ack?.({
            ok: true,
            data: {
              roomId: payload.roomId,
              role: "editor",
              status: "open",
            },
          });
        }
      );

      socket.on(
        "chat:send",
        (
          payload: { roomId: string; text: string; clientMsgId: string },
          ack?: (res: unknown) => void
        ) => {
          const roomChannel = `room:${payload.roomId}`;
          const messageDto = {
            id: `msg_srv_${Date.now()}`,
            roomId: payload.roomId,
            authorId: "member_alice",
            authorName: "Alice Tester",
            seq: 1,
            clientMsgId: payload.clientMsgId,
            text: payload.text,
            ts: new Date().toISOString(),
            kind: "user",
          };

          // Broadcast to room including sender (per amendment 1)
          ioServer.to(roomChannel).emit("chat:message", {
            roomId: payload.roomId,
            message: messageDto,
          });

          ack?.({
            ok: true,
            data: {
              messageId: messageDto.id,
              seq: messageDto.seq,
              ts: messageDto.ts,
            },
          });
        }
      );
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        if (typeof addr === "object" && addr) {
          port = addr.port;
          serverUrl = `http://127.0.0.1:${port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    ioServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("1. verifies middleware-rejected handshake produces connect_error and stops auto-reconnecting (socket.active is false)", async () => {
    shouldRejectHandshake = true;

    const socket: ClientSocket = createClientSocket(serverUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 100,
    });

    let connectErrorReceived = false;
    let errorMessage = "";

    await new Promise<void>((resolve) => {
      socket.on("connect_error", (err) => {
        connectErrorReceived = true;
        errorMessage = err.message;
        resolve();
      });
    });

    expect(connectErrorReceived).toBe(true);
    expect(errorMessage).toBe("Unauthorized origin");

    // Socket.IO v4.8.4 contract: Handshake rejection in middleware halts active reconnection!
    expect(socket.active).toBe(false);

    // Wait 250ms to verify no background reconnect occurs
    let reconnectFired = false;
    socket.on("reconnect_attempt", () => {
      reconnectFired = true;
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(reconnectFired).toBe(false);

    socket.disconnect();
    shouldRejectHandshake = false;
  });

  it("2. verifies real WebSocket transport contract: room:join ack, chat:send with canonical clientMsgId, and sender-inclusive broadcast", async () => {
    shouldRejectHandshake = false;

    const socket: ClientSocket = createClientSocket(serverUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", (e) => reject(e));
    });

    expect(socket.connected).toBe(true);

    // 1. room:join contract
    const joinAck = await new Promise<{ ok: boolean; data: { role: string } }>(
      (resolve) => {
        socket.emit(
          "room:join",
          { roomId: "507f1f77bcf86cd799439011" },
          (ack: unknown) => {
            resolve(ack as { ok: boolean; data: { role: string } });
          }
        );
      }
    );

    expect(joinAck.ok).toBe(true);
    expect(joinAck.data.role).toBe("editor");

    // 2. chat:send with canonical clientMsgId contract
    const testClientMsgId = "contract-test-uuid-4444";
    let broadcastMessageReceived: unknown = null;

    socket.on("chat:message", (payload: unknown) => {
      broadcastMessageReceived = payload;
    });

    const sendAck = await new Promise<{ ok: boolean; data: { seq: number } }>(
      (resolve) => {
        socket.emit(
          "chat:send",
          {
            roomId: "507f1f77bcf86cd799439011",
            text: "Real contract message",
            clientMsgId: testClientMsgId,
          },
          (ack: unknown) => {
            resolve(ack as { ok: boolean; data: { seq: number } });
          }
        );
      }
    );

    expect(sendAck.ok).toBe(true);
    expect(sendAck.data.seq).toBe(1);

    // Verify broadcast arrived on the sending socket (sender-inclusive)
    expect(broadcastMessageReceived).toBeDefined();
    const typedBroadcast = broadcastMessageReceived as {
      roomId: string;
      message: {
        id: string;
        clientMsgId: string;
        authorId: string;
        authorName: string;
        seq: number;
        text: string;
      };
    };

    expect(typedBroadcast.message.clientMsgId).toBe(testClientMsgId);
    expect(typedBroadcast.message.authorId).toBe("member_alice");
    expect(typedBroadcast.message.authorName).toBe("Alice Tester");
    expect(typedBroadcast.message.seq).toBe(1);
    expect(typedBroadcast.message.text).toBe("Real contract message");

    socket.disconnect();
  });

  it("3. verifies deliberate teardown (socket.disconnect()) halts active manager and reconnect", async () => {
    const socket: ClientSocket = createClientSocket(serverUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
    });

    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
    });

    expect(socket.connected).toBe(true);
    expect(socket.active).toBe(true);

    // Deliberate teardown
    socket.disconnect();

    expect(socket.connected).toBe(false);
    expect(socket.active).toBe(false);

    // No reconnect should fire
    let reconnected = false;
    socket.on("reconnect", () => {
      reconnected = true;
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(reconnected).toBe(false);
  });
});
