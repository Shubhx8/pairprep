import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSyncServer } from "../../sync/hocuspocus.js";
import { ConnectionRateLimiter } from "../../sync/connectionRateLimiter.js";
import type { Connection, Document } from "@hocuspocus/server";

describe("Hocuspocus Stateless Latency Ping/Pong Handler", () => {
  let rateLimiter: ConnectionRateLimiter;
  let syncServer: ReturnType<typeof createSyncServer>;
  let onStateless: (data: {
    connection: Connection;
    document: Document;
    documentName: string;
    payload: string;
  }) => Promise<void>;

  beforeEach(() => {
    rateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 20,
      messageRefillPerSec: 20,
      maxByteBurst: 20000,
      byteRefillPerSec: 20000,
    });
    syncServer = createSyncServer({
      requireAuth: false,
      rateLimiter,
    });
    const config = syncServer.server.configuration as unknown as {
      onStateless: typeof onStateless;
    };
    onStateless = config.onStateless;
  });

  const createMockConnection = (socketId: string | undefined, readOnly = false) => {
    const sentMessages: string[] = [];
    const conn = {
      socketId,
      readOnly,
      context: { readOnly },
      sendStateless: vi.fn((payload: string) => {
        sentMessages.push(payload);
      }),
    } as unknown as Connection & { sentMessages: string[] };
    conn.sentMessages = sentMessages;
    return conn;
  };

  const createMockDocument = () => {
    return {
      broadcastStateless: vi.fn(),
    } as unknown as Document;
  };

  // 1. Valid latency_ping receives latency_pong
  it("receives latency_pong when a valid latency_ping is sent", async () => {
    const conn = createMockConnection("socket-valid-1");
    const doc = createMockDocument();

    const payload = JSON.stringify({
      type: "latency_ping",
      nonce: "test-nonce-123",
      sentAt: 123456789,
    });

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload,
    });

    expect(conn.sendStateless).toHaveBeenCalledTimes(1);
    const response = JSON.parse(conn.sentMessages[0]!);
    expect(response.type).toBe("latency_pong");
  });

  // 2. Exact nonce and sentAt values are preserved
  it("preserves exact nonce and sentAt values in latency_pong response", async () => {
    const conn = createMockConnection("socket-preserve-2");
    const doc = createMockDocument();
    const nonce = "custom-nonce-xyz-456";
    const sentAt = 1700000000123;

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce,
        sentAt,
      }),
    });

    expect(conn.sendStateless).toHaveBeenCalledTimes(1);
    const response = JSON.parse(conn.sentMessages[0]!);
    expect(response.nonce).toBe(nonce);
    expect(response.sentAt).toBe(sentAt);
    expect(typeof response.serverTime).toBe("number");
    expect(response.serverTime).toBeGreaterThan(0);
  });

  // 3. Pong is sent only to originating connection
  it("sends pong strictly unicast to the originating connection, not broadcast", async () => {
    const connSender = createMockConnection("socket-sender-3");
    const doc = createMockDocument();

    await onStateless({
      connection: connSender,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-3",
        sentAt: 1000,
      }),
    });

    expect(connSender.sendStateless).toHaveBeenCalledTimes(1);
    expect(doc.broadcastStateless).not.toHaveBeenCalled();
  });

  // 4. Read-only connection receives pong
  it("allows read-only connections to send latency_ping and receive latency_pong", async () => {
    const connReadOnly = createMockConnection("socket-ro-4", true);
    const doc = createMockDocument();

    await onStateless({
      connection: connReadOnly,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "ro-nonce",
        sentAt: 2000,
      }),
    });

    expect(connReadOnly.sendStateless).toHaveBeenCalledTimes(1);
    const response = JSON.parse(connReadOnly.sentMessages[0]!);
    expect(response.type).toBe("latency_pong");
  });

  // 5. Payload exceeding 256 UTF-8 bytes is rejected
  it("rejects payload exceeding 256 UTF-8 bytes", async () => {
    const conn = createMockConnection("socket-oversized-5");
    const doc = createMockDocument();

    const oversizedPayload = JSON.stringify({
      type: "latency_ping",
      nonce: "a".repeat(300),
      sentAt: 1000,
    });

    expect(Buffer.byteLength(oversizedPayload, "utf8")).toBeGreaterThan(256);

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: oversizedPayload,
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 6. Multibyte UTF-8 payload exceeding the limit is rejected
  it("rejects multibyte UTF-8 payload exceeding 256 bytes", async () => {
    const conn = createMockConnection("socket-multibyte-6");
    const doc = createMockDocument();

    const multibytePayload = JSON.stringify({
      type: "latency_ping",
      nonce: "🔥".repeat(70), // 70 * 4 = 280 bytes
      sentAt: 1000,
    });

    expect(multibytePayload.length).toBeLessThan(256); // String length is small
    expect(Buffer.byteLength(multibytePayload, "utf8")).toBeGreaterThan(256);

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: multibytePayload,
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 7. Malformed JSON is rejected
  it("rejects malformed JSON payload without crashing", async () => {
    const conn = createMockConnection("socket-malformed-7");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: "{ invalid-json, missing-quotes: true",
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 8. Null and array payloads are rejected
  it("rejects null and array payloads", async () => {
    const conn = createMockConnection("socket-null-arr-8");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: "null",
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify(["latency_ping", "nonce", 123]),
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 9. Missing fields are rejected
  it("rejects objects with missing fields", async () => {
    const conn = createMockConnection("socket-missing-9");
    const doc = createMockDocument();

    // Missing sentAt
    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "valid-nonce",
      }),
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();

    // Missing nonce
    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        sentAt: 1000,
      }),
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 10. Additional object properties are rejected
  it("rejects payloads containing additional unknown properties (extra keys)", async () => {
    const conn = createMockConnection("socket-extra-10");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-10",
        sentAt: 1000,
        extraProperty: "malicious_or_unexpected",
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 11. Unknown message types are rejected
  it("rejects unknown message types", async () => {
    const conn = createMockConnection("socket-unknown-11");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "unknown_ping",
        nonce: "nonce-11",
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 12. Non-finite sentAt is rejected
  it("rejects non-finite or non-numeric sentAt timestamps", async () => {
    const conn = createMockConnection("socket-nonfinite-12");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-12",
        sentAt: "1000", // String instead of number
      }),
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-12",
        sentAt: null,
      }),
    });
    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 13. Missing socket ID is rejected
  it("rejects requests when socket ID is missing", async () => {
    const connNoSocket = createMockConnection(undefined);
    const doc = createMockDocument();

    await onStateless({
      connection: connNoSocket,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-13",
        sentAt: 1000,
      }),
    });

    expect(connNoSocket.sendStateless).not.toHaveBeenCalled();
  });

  // 14. Invalid socket ID is rejected
  it("rejects requests when socket ID is empty or whitespace only", async () => {
    const connWhitespace = createMockConnection("   ");
    const doc = createMockDocument();

    await onStateless({
      connection: connWhitespace,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "nonce-14",
        sentAt: 1000,
      }),
    });

    expect(connWhitespace.sendStateless).not.toHaveBeenCalled();
  });

  // 15. Rate-limited flooding produces no additional pong responses
  it("rejects flooding and produces no additional pong responses once rate limit is exhausted", async () => {
    const connFlood = createMockConnection("socket-flood-15");
    const doc = createMockDocument();

    const payload = JSON.stringify({
      type: "latency_ping",
      nonce: "flood-nonce",
      sentAt: 1000,
    });

    // Burst limit is 20
    for (let i = 0; i < 20; i++) {
      await onStateless({
        connection: connFlood,
        document: doc,
        documentName: "test-room",
        payload,
      });
    }
    expect(connFlood.sendStateless).toHaveBeenCalledTimes(20);

    // 21st request must be rate limited and dropped
    await onStateless({
      connection: connFlood,
      document: doc,
      documentName: "test-room",
      payload,
    });
    expect(connFlood.sendStateless).toHaveBeenCalledTimes(20);
  });

  // 16. Empty nonce is rejected
  it("rejects payload with empty string nonce", async () => {
    const conn = createMockConnection("socket-empty-nonce-16");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "",
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 17. Nonce exceeding 128 characters is rejected
  it("rejects payload with nonce exceeding 128 characters", async () => {
    const conn = createMockConnection("socket-oversized-nonce-17");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "x".repeat(129),
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 18. Malformed messages consume per-connection rate limiter tokens
  it("subjects malformed messages to the per-connection rate limiter", async () => {
    const conn = createMockConnection("socket-malformed-rate-18");
    const doc = createMockDocument();

    // Send 20 malformed messages to exhaust message burst
    for (let i = 0; i < 20; i++) {
      await onStateless({
        connection: conn,
        document: doc,
        documentName: "test-room",
        payload: "{ invalid malformed json ",
      });
    }

    // 21st message is valid but should be dropped due to rate limit exhaustion
    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "after-flood-nonce",
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 19. Non-string socketId is safely rejected
  it("rejects requests when socket ID is not a string", async () => {
    const conn = createMockConnection(12345 as unknown as string);
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "test-nonce",
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).not.toHaveBeenCalled();
  });

  // 20. Latency ping produces zero Y.Doc mutations
  it("does not mutate or modify Y.Doc contents", async () => {
    const conn = createMockConnection("socket-no-mutation-20");
    const doc = createMockDocument();

    await onStateless({
      connection: conn,
      document: doc,
      documentName: "test-room",
      payload: JSON.stringify({
        type: "latency_ping",
        nonce: "no-mutation-nonce",
        sentAt: 1000,
      }),
    });

    expect(conn.sendStateless).toHaveBeenCalledTimes(1);
    expect(doc.broadcastStateless).not.toHaveBeenCalled();
  });
});
