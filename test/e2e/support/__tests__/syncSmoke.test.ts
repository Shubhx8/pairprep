import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";
import mongoose from "mongoose";
import type session from "express-session";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";

// Ensure test environment variables are set before imports read config
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] =
  process.env["SESSION_SECRET"] || "test_session_secret_at_least_32_characters_long";
process.env["MONGODB_URI"] =
  process.env["MONGODB_URI"] || "mongodb://127.0.0.1:27017/pairprep_test";

import {
  setupTestDb,
  teardownTestDb,
  clearTestDb,
} from "../../../../apps/server/src/__tests__/db/testDb.js";
import { UserModel } from "../../../../apps/server/src/models/users.js";
import { RoomModel } from "../../../../apps/server/src/models/rooms.js";
import { RoomMemberModel } from "../../../../apps/server/src/models/room_members.js";
import { guestRepo } from "../../../../apps/server/src/repos/guestRepo.js";
import { signGuestCookie } from "../../../../apps/server/src/middleware/identity.js";
import {
  SESSION_COOKIE_NAME,
  getSessionStore,
} from "../../../../apps/server/src/middleware/session.js";
import { config } from "../../../../apps/server/src/config.js";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../../../apps/server/src/sync/hocuspocus.js";
import { syncRegistry } from "../../../../apps/server/src/sync/syncRegistry.js";
import { resetPersistenceState } from "../../../../apps/server/src/sync/persistence.js";
import { isValidRoomId } from "../../../../apps/web/src/lib/roomId.js";

function signExpressSessionCookie(val: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}

describe("PairPrep T08 Phase 2 — Real Hocuspocus WebSocket Connection Smoke Test", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let port: number;

  const providersToCleanup: HocuspocusProvider[] = [];
  const wsProvidersToCleanup: HocuspocusProviderWebsocket[] = [];

  beforeAll(async () => {
    (config as { SESSION_SECRET?: string }).SESSION_SECRET =
      config.SESSION_SECRET || "test_session_secret_at_least_32_characters_long";
    await setupTestDb("sync_smoke_real");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    await clearTestDb();

    // Start real T07 Hocuspocus server on dynamic port
    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer();
    attachSyncServer(httpServer, syncServer);

    port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });
  });

  afterEach(async () => {
    for (const p of providersToCleanup) {
      try {
        p.destroy();
      } catch {
        // ignore
      }
    }
    providersToCleanup.length = 0;

    for (const ws of wsProvidersToCleanup) {
      try {
        ws.destroy();
      } catch {
        // ignore
      }
    }
    wsProvidersToCleanup.length = 0;

    // Allow in-flight disconnect hooks to settle
    await new Promise((r) => setTimeout(r, 50));

    if (syncServer) {
      try {
        await syncServer.destroy();
      } catch {
        // ignore
      }
      syncServer = null;
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }

    resetPersistenceState();
    syncRegistry.resetAll();
  });

  it("successfully connects, authenticates via session cookie, synchronizes Y.Doc, and edits", async () => {
    // 1. Seed real user, room, and membership in MongoDB
    const userId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    expect(isValidRoomId(roomId)).toBe(true);

    await UserModel.create({
      _id: userId,
      email: "engineer.alice@pairprep.com",
      displayName: "Alice Engineer",
      role: "user",
      provider: "github",
      providerId: `gh_${Date.now()}`,
    });

    await RoomModel.create({
      _id: roomId,
      title: "Real Collaborative Smoke Room",
      slug: "smoke-test-room-slug",
      type: "practice",
      status: "open",
      ownerId: userId,
      language: "javascript",
    });

    await RoomMemberModel.create({
      roomId,
      memberId: userId,
      displayName: "Alice Engineer",
      role: "editor",
      joinedAt: new Date(),
    });

    // 2. Seed active express session
    const store = getSessionStore();
    expect(store).not.toBeNull();
    const rawSid = `sess_alice_${Date.now()}`;

    await new Promise<void>((resolve, reject) => {
      store!.set(
        rawSid,
        {
          cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
          passport: { user: userId },
        } as unknown as session.SessionData,
        (err) => (err ? reject(err) : resolve())
      );
    });

    const secret = config.SESSION_SECRET || process.env["SESSION_SECRET"]!;
    const cookieHeader = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
      rawSid,
      secret
    )}`;

    // 3. WebSocketPolyfill simulating browser WebSocket sending same-origin cookie & origin
    class AuthenticatedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: cookieHeader,
          },
        });
      }
    }

    // 4. Connect via HocuspocusProvider
    const doc = new Y.Doc();
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: AuthenticatedWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    // 5. Verify provider connects and synchronizes
    let isAuthenticated = false;
    let isSynced = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Connection and synchronization timed out")),
        5000
      );

      provider.on("authenticated", () => {
        isAuthenticated = true;
      });

      provider.on("synced", ({ state }: { state: boolean }) => {
        if (state) {
          isSynced = true;
          clearTimeout(timer);
          resolve();
        }
      });

      provider.on("authenticationFailed", (data: { reason: string }) => {
        clearTimeout(timer);
        reject(new Error(`Authentication failed unexpectedly: ${data.reason}`));
      });

      provider.attach();
    });

    expect(isAuthenticated).toBe(true);
    expect(isSynced).toBe(true);
    expect(provider.configuration.name).toBe(roomId);
    expect(wsProvider.status).toBe(WebSocketStatus.Connected);

    // 6. Test real collaborative editing
    doc.getText("code").insert(0, "function solve() { return 42; }\n");
    expect(doc.getText("code").toString()).toBe("function solve() { return 42; }\n");

    // 7. Verify capacity registered in T07 server syncRegistry
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);

    // 8. Clean up provider and verify connection count drops
    provider.destroy();
    wsProvider.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
  });

  it("synchronizes collaborative edits bidirectionally between two distinct authenticated clients", async () => {
    // 1. Seed two users, room, and memberships in MongoDB
    const userAId = new mongoose.Types.ObjectId().toHexString();
    const userBId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    await UserModel.create([
      {
        _id: userAId,
        email: "alice.collab@pairprep.com",
        displayName: "Alice Collab",
        role: "user",
        provider: "github",
        providerId: `gh_alice_${Date.now()}`,
      },
      {
        _id: userBId,
        email: "bob.collab@pairprep.com",
        displayName: "Bob Collab",
        role: "user",
        provider: "google",
        providerId: `goog_bob_${Date.now()}`,
      },
    ]);

    await RoomModel.create({
      _id: roomId,
      title: "Two-Client Collaborative Smoke Room",
      slug: "two-client-smoke-room-slug",
      type: "practice",
      status: "open",
      ownerId: userAId,
      language: "javascript",
    });

    await RoomMemberModel.create([
      {
        roomId,
        memberId: userAId,
        displayName: "Alice Collab",
        role: "editor",
        joinedAt: new Date(),
      },
      {
        roomId,
        memberId: userBId,
        displayName: "Bob Collab",
        role: "editor",
        joinedAt: new Date(),
      },
    ]);

    // 2. Seed active sessions in MongoStore for Alice and Bob
    const store = getSessionStore();
    expect(store).not.toBeNull();

    const rawSidA = `sess_alice_collab_${Date.now()}`;
    const rawSidB = `sess_bob_collab_${Date.now()}`;

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        store!.set(
          rawSidA,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: userAId },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      }),
      new Promise<void>((resolve, reject) => {
        store!.set(
          rawSidB,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: userBId },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      }),
    ]);

    const secret = config.SESSION_SECRET || process.env["SESSION_SECRET"]!;
    const cookieHeaderA = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
      rawSidA,
      secret
    )}`;
    const cookieHeaderB = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
      rawSidB,
      secret
    )}`;

    class AliceWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: cookieHeaderA,
          },
        });
      }
    }

    class BobWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: cookieHeaderB,
          },
        });
      }
    }

    // 3. Create independent Y.Docs and providers for Client A and Client B
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const wsProviderA = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: AliceWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProviderA);

    const providerA = new HocuspocusProvider({
      websocketProvider: wsProviderA,
      name: roomId,
      document: docA,
    });
    providersToCleanup.push(providerA);

    const wsProviderB = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: BobWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProviderB);

    const providerB = new HocuspocusProvider({
      websocketProvider: wsProviderB,
      name: roomId,
      document: docB,
    });
    providersToCleanup.push(providerB);

    // Explicitly attach both providers
    providerA.attach();
    providerB.attach();

    // 4. Wait for both clients to authenticate and synchronize with bounded timeout
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Client A connection/sync timed out")),
          5000
        );
        providerA.on("synced", ({ state }: { state: boolean }) => {
          if (state) {
            clearTimeout(timer);
            resolve();
          }
        });
        providerA.on("authenticationFailed", (data: { reason: string }) => {
          clearTimeout(timer);
          reject(new Error(`Client A auth failed: ${data.reason}`));
        });
      }),
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Client B connection/sync timed out")),
          5000
        );
        providerB.on("synced", ({ state }: { state: boolean }) => {
          if (state) {
            clearTimeout(timer);
            resolve();
          }
        });
        providerB.on("authenticationFailed", (data: { reason: string }) => {
          clearTimeout(timer);
          reject(new Error(`Client B auth failed: ${data.reason}`));
        });
      }),
    ]);

    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(2);

    // 5. Client A writes initial code
    const initialText = "function solution() {\n";
    docA.getText("code").insert(0, initialText);

    // 6. Client B waits to receive Client A's edit via CRDT convergence
    await new Promise<void>((resolve, reject) => {
      const codeB = docB.getText("code");
      if (codeB.toString().includes(initialText)) {
        return resolve();
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Client B timed out waiting for Client A's edit. Current value: "${codeB.toString()}"`
            )
          ),
        5000
      );
      const observer = () => {
        if (codeB.toString().includes(initialText)) {
          clearTimeout(timer);
          codeB.unobserve(observer);
          resolve();
        }
      };
      codeB.observe(observer);
    });

    // 7. Client B appends code
    const additionText = "  return 42;\n}\n";
    const currentLenB = docB.getText("code").length;
    docB.getText("code").insert(currentLenB, additionText);

    // 8. Client A waits to receive Client B's addition
    await new Promise<void>((resolve, reject) => {
      const codeA = docA.getText("code");
      if (codeA.toString().includes("return 42;")) {
        return resolve();
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Client A timed out waiting for Client B's edit. Current value: "${codeA.toString()}"`
            )
          ),
        5000
      );
      const observer = () => {
        if (codeA.toString().includes("return 42;")) {
          clearTimeout(timer);
          codeA.unobserve(observer);
          resolve();
        }
      };
      codeA.observe(observer);
    });

    // 9. Assert exact state vector and text content convergence between both peers
    const expectedFinalCode = "function solution() {\n  return 42;\n}\n";
    expect(docA.getText("code").toString()).toBe(expectedFinalCode);
    expect(docB.getText("code").toString()).toBe(expectedFinalCode);

    const stateVectorA = Y.encodeStateVector(docA);
    const stateVectorB = Y.encodeStateVector(docB);
    expect(Buffer.from(stateVectorA).toString("hex")).toBe(
      Buffer.from(stateVectorB).toString("hex")
    );

    // 10. Destroy both providers and verify server connection count returns to 0
    providerA.destroy();
    wsProviderA.destroy();
    docA.destroy();

    providerB.destroy();
    wsProviderB.destroy();
    docB.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
  });

  it("converges deterministically when two clients perform simultaneous concurrent Y.Text insertions at the same position", async () => {
    // 1. Declare fixture identifiers and nullable resource references
    const userAId = new mongoose.Types.ObjectId().toHexString();
    const userBId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    const rawSidA = `sess_alice_concurrent_${Date.now()}`;
    const rawSidB = `sess_bob_concurrent_${Date.now()}`;

    let usersCreated = false;
    let roomCreated = false;
    let membersCreated = false;
    let sessionsCreated = false;

    let docA: Y.Doc | null = null;
    let docB: Y.Doc | null = null;
    let wsProviderA: HocuspocusProviderWebsocket | null = null;
    let wsProviderB: HocuspocusProviderWebsocket | null = null;
    let providerA: HocuspocusProvider | null = null;
    let providerB: HocuspocusProvider | null = null;

    try {
      // 2. Seed two distinct authenticated users, room, and memberships in MongoDB
      await UserModel.create([
        {
          _id: userAId,
          email: "alice.concurrent@pairprep.com",
          displayName: "Alice Concurrent",
          role: "user",
          provider: "github",
          providerId: `gh_alice_conc_${Date.now()}`,
        },
        {
          _id: userBId,
          email: "bob.concurrent@pairprep.com",
          displayName: "Bob Concurrent",
          role: "user",
          provider: "google",
          providerId: `goog_bob_conc_${Date.now()}`,
        },
      ]);
      usersCreated = true;

      await RoomModel.create({
        _id: roomId,
        title: "Concurrent Same-Position Smoke Room",
        slug: "concurrent-same-position-smoke-room",
        type: "practice",
        status: "open",
        ownerId: userAId,
        language: "javascript",
      });
      roomCreated = true;

      await RoomMemberModel.create([
        {
          roomId,
          memberId: userAId,
          displayName: "Alice Concurrent",
          role: "editor",
          joinedAt: new Date(),
        },
        {
          roomId,
          memberId: userBId,
          displayName: "Bob Concurrent",
          role: "editor",
          joinedAt: new Date(),
        },
      ]);
      membersCreated = true;

      // 3. Seed active sessions in MongoStore for Alice and Bob
      const store = getSessionStore();
      expect(store).not.toBeNull();

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          store!.set(
            rawSidA,
            {
              cookie: {
                originalMaxAge: 3600000,
                expires: new Date(Date.now() + 3600000),
              },
              passport: { user: userAId },
            } as unknown as session.SessionData,
            (err) => (err ? reject(err) : resolve())
          );
        }),
        new Promise<void>((resolve, reject) => {
          store!.set(
            rawSidB,
            {
              cookie: {
                originalMaxAge: 3600000,
                expires: new Date(Date.now() + 3600000),
              },
              passport: { user: userBId },
            } as unknown as session.SessionData,
            (err) => (err ? reject(err) : resolve())
          );
        }),
      ]);
      sessionsCreated = true;

      const secret = config.SESSION_SECRET || process.env["SESSION_SECRET"]!;
      const cookieHeaderA = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
        rawSidA,
        secret
      )}`;
      const cookieHeaderB = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(
        rawSidB,
        secret
      )}`;

      class AliceConcurrentWs extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: cookieHeaderA,
            },
          });
        }
      }

      class BobConcurrentWs extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: cookieHeaderB,
            },
          });
        }
      }

      // 4. Create independent Y.Docs and providers for Client A and Client B
      docA = new Y.Doc();
      docB = new Y.Doc();

      wsProviderA = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: AliceConcurrentWs as unknown as typeof WebSocket,
      });

      providerA = new HocuspocusProvider({
        websocketProvider: wsProviderA,
        name: roomId,
        document: docA,
      });

      wsProviderB = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: BobConcurrentWs as unknown as typeof WebSocket,
      });

      providerB = new HocuspocusProvider({
        websocketProvider: wsProviderB,
        name: roomId,
        document: docB,
      });

      // Explicitly attach both providers
      providerA.attach();
      providerB.attach();

      // 5. Wait for both clients to authenticate and synchronize with bounded timeout
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Client A connection/sync timed out")),
            5000
          );
          providerA!.on("synced", ({ state }: { state: boolean }) => {
            if (state) {
              clearTimeout(timer);
              resolve();
            }
          });
          providerA!.on("authenticationFailed", (data: { reason: string }) => {
            clearTimeout(timer);
            reject(new Error(`Client A auth failed: ${data.reason}`));
          });
        }),
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Client B connection/sync timed out")),
            5000
          );
          providerB!.on("synced", ({ state }: { state: boolean }) => {
            if (state) {
              clearTimeout(timer);
              resolve();
            }
          });
          providerB!.on("authenticationFailed", (data: { reason: string }) => {
            clearTimeout(timer);
            reject(new Error(`Client B auth failed: ${data.reason}`));
          });
        }),
      ]);

      expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(2);

      // 6. Establish known shared baseline text
      const initialText = "ABCDEF";
      docA.getText("code").insert(0, initialText);

      // Wait for Client B to observe initialText before proceeding to concurrent edit
      await new Promise<void>((resolve, reject) => {
        const codeB = docB!.getText("code");
        if (codeB.toString() === initialText) {
          return resolve();
        }
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Client B timed out waiting for initial baseline text. Current: "${codeB.toString()}"`
              )
            ),
          5000
        );
        const observer = () => {
          if (codeB.toString() === initialText) {
            clearTimeout(timer);
            codeB.unobserve(observer);
            resolve();
          }
        };
        codeB.observe(observer);
      });

      // Both clients now have identical text: "ABCDEF" (length 6)
      expect(docA.getText("code").toString()).toBe("ABCDEF");
      expect(docB.getText("code").toString()).toBe("ABCDEF");

      // 7. Concurrently insert distinct characters at the EXACT SAME shared index (index 3)
      //    Synchronous execution in the same tick guarantees neither client receives the
      //    other's network message before generating its local CRDT operation against the
      //    identical initial state vector.
      docA.getText("code").insert(3, "111");
      docB.getText("code").insert(3, "222");

      // 8. Wait with bounded timeout for both documents to converge
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const textA = docA!.getText("code");
          if (
            textA.length === 12 &&
            textA.toString().includes("111") &&
            textA.toString().includes("222")
          ) {
            return resolve();
          }
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `docA convergence timed out. Current value: "${textA.toString()}"`
                )
              ),
            5000
          );
          const observer = () => {
            if (
              textA.length === 12 &&
              textA.toString().includes("111") &&
              textA.toString().includes("222")
            ) {
              clearTimeout(timer);
              textA.unobserve(observer);
              resolve();
            }
          };
          textA.observe(observer);
        }),
        new Promise<void>((resolve, reject) => {
          const textB = docB!.getText("code");
          if (
            textB.length === 12 &&
            textB.toString().includes("111") &&
            textB.toString().includes("222")
          ) {
            return resolve();
          }
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  `docB convergence timed out. Current value: "${textB.toString()}"`
                )
              ),
            5000
          );
          const observer = () => {
            if (
              textB.length === 12 &&
              textB.toString().includes("111") &&
              textB.toString().includes("222")
            ) {
              clearTimeout(timer);
              textB.unobserve(observer);
              resolve();
            }
          };
          textB.observe(observer);
        }),
      ]);

      const finalA = docA.getText("code").toString();
      const finalB = docB.getText("code").toString();

      // 9. Assertions:
      // a. Both inserted characters are present
      expect(finalA).toContain("111");
      expect(finalA).toContain("222");
      expect(finalB).toContain("111");
      expect(finalB).toContain("222");

      // b. Neither insertion was lost (exact expected length: 6 baseline + 3 + 3 = 12)
      expect(finalA.length).toBe(12);
      expect(finalB.length).toBe(12);

      // c. Final text values on both clients are identical (convergence)
      expect(finalA).toBe(finalB);

      // d. CRDT convergence validly resolves to one of the two consistent character orders:
      //    "ABC111222DEF" or "ABC222111DEF"
      expect(["ABC111222DEF", "ABC222111DEF"]).toContain(finalA);

      // e. Assert exact encoded state vector convergence between both peers
      const stateVectorA = Y.encodeStateVector(docA);
      const stateVectorB = Y.encodeStateVector(docB);
      expect(Buffer.from(stateVectorA).toString("hex")).toBe(
        Buffer.from(stateVectorB).toString("hex")
      );
    } finally {
      // 10. Clean up both providers, WebSocket providers, and Y.Docs in ownership order
      if (providerA) {
        try {
          providerA.destroy();
        } catch {
          // ignore
        }
      }
      if (wsProviderA) {
        try {
          wsProviderA.destroy();
        } catch {
          // ignore
        }
      }
      if (docA) {
        try {
          docA.destroy();
        } catch {
          // ignore
        }
      }

      if (providerB) {
        try {
          providerB.destroy();
        } catch {
          // ignore
        }
      }
      if (wsProviderB) {
        try {
          wsProviderB.destroy();
        } catch {
          // ignore
        }
      }
      if (docB) {
        try {
          docB.destroy();
        } catch {
          // ignore
        }
      }

      // 11. Clean up database fixtures and sessions
      if (membersCreated) {
        try {
          await RoomMemberModel.deleteMany({
            roomId,
            memberId: { $in: [userAId, userBId] },
          });
        } catch (err) {
          console.error("[syncSmoke] RoomMemberModel cleanup error:", err);
        }
      }

      if (roomCreated) {
        try {
          await RoomModel.deleteOne({ _id: roomId });
        } catch (err) {
          console.error("[syncSmoke] RoomModel cleanup error:", err);
        }
      }

      if (usersCreated) {
        try {
          await UserModel.deleteMany({ _id: { $in: [userAId, userBId] } });
        } catch (err) {
          console.error("[syncSmoke] UserModel cleanup error:", err);
        }
      }

      if (sessionsCreated) {
        try {
          const store = getSessionStore();
          if (store) {
            await Promise.all([
              new Promise<void>((res) => store.destroy(rawSidA, () => res())),
              new Promise<void>((res) => store.destroy(rawSidB, () => res())),
            ]);
          } else {
            await mongoose.connection
              .collection("sessions")
              .deleteMany({ _id: { $in: [rawSidA, rawSidB] } });
          }
        } catch (err) {
          console.error("[syncSmoke] Session cleanup error:", err);
        }
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    // Verify all fixtures and connections were removed
    expect(await RoomMemberModel.find({ roomId })).toHaveLength(0);
    expect(await RoomModel.findById(roomId)).toBeNull();
    expect(await UserModel.find({ _id: { $in: [userAId, userBId] } })).toHaveLength(0);
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
  });

  it("cleans up previously created resources if setup fails midway through concurrent initialization", async () => {
    const destructionLog: string[] = [];

    let docA: Y.Doc | null = null;
    let wsProviderA: HocuspocusProviderWebsocket | null = null;
    let providerA: HocuspocusProvider | null = null;

    let docB: Y.Doc | null = null;
    let wsProviderB: HocuspocusProviderWebsocket | null = null;
    let providerB: HocuspocusProvider | null = null;

    class DummyPolyfillA extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { origin: "http://localhost:3000" } });
        this.on("error", () => {});
      }
    }

    class DummyPolyfillB extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { origin: "http://localhost:3000" } });
        this.on("error", () => {});
      }
    }

    const testError = new Error("Simulated failure during Client B attachment");

    try {
      // 1. Construct Client A's Y.Doc
      docA = new Y.Doc();
      const origDocADestroy = docA.destroy.bind(docA);
      docA.destroy = () => {
        destructionLog.push("docA");
        origDocADestroy();
      };

      // 2. Construct Client A's WebSocket provider
      wsProviderA = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: DummyPolyfillA as unknown as typeof WebSocket,
      });
      const origWsADestroy = wsProviderA.destroy.bind(wsProviderA);
      wsProviderA.destroy = () => {
        destructionLog.push("wsProviderA");
        origWsADestroy();
      };

      // 3. Construct Client A's Hocuspocus provider
      providerA = new HocuspocusProvider({
        websocketProvider: wsProviderA,
        name: "507f1f77bcf86cd799439011",
        document: docA,
      });
      const origProvADestroy = providerA.destroy.bind(providerA);
      providerA.destroy = () => {
        destructionLog.push("providerA");
        origProvADestroy();
      };

      // 4. Attach Client A
      providerA.attach();

      // 5. Construct Client B's Y.Doc
      docB = new Y.Doc();
      const origDocBDestroy = docB.destroy.bind(docB);
      docB.destroy = () => {
        destructionLog.push("docB");
        origDocBDestroy();
      };

      // 6. Construct Client B's WebSocket provider
      wsProviderB = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: DummyPolyfillB as unknown as typeof WebSocket,
      });
      const origWsBDestroy = wsProviderB.destroy.bind(wsProviderB);
      wsProviderB.destroy = () => {
        destructionLog.push("wsProviderB");
        origWsBDestroy();
      };

      // 7. Construct Client B's Hocuspocus provider
      providerB = new HocuspocusProvider({
        websocketProvider: wsProviderB,
        name: "507f1f77bcf86cd799439011",
        document: docB,
      });
      const origProvBDestroy = providerB.destroy.bind(providerB);
      providerB.destroy = () => {
        destructionLog.push("providerB");
        origProvBDestroy();
      };

      // 8. Inject deterministic failure during Client B's attachment
      providerB.attach = () => {
        throw testError;
      };
      providerB.attach();
    } catch (err) {
      expect(err).toBe(testError);
    } finally {
      // Teardown Client A in exact ownership order: provider -> wsProvider -> doc
      if (providerA) {
        try {
          providerA.destroy();
        } catch {
          // ignore
        }
      }
      if (wsProviderA) {
        try {
          wsProviderA.destroy();
        } catch {
          // ignore
        }
      }
      if (docA) {
        try {
          docA.destroy();
        } catch {
          // ignore
        }
      }

      // Teardown Client B in exact ownership order: provider -> wsProvider -> doc
      if (providerB) {
        try {
          providerB.destroy();
        } catch {
          // ignore
        }
      }
      if (wsProviderB) {
        try {
          wsProviderB.destroy();
        } catch {
          // ignore
        }
      }
      if (docB) {
        try {
          docB.destroy();
        } catch {
          // ignore
        }
      }
    }

    // Assertions:
    // 1. All 6 resources destroyed
    expect(destructionLog).toContain("providerA");
    expect(destructionLog).toContain("wsProviderA");
    expect(destructionLog).toContain("docA");
    expect(destructionLog).toContain("providerB");
    expect(destructionLog).toContain("wsProviderB");
    expect(destructionLog).toContain("docB");

    // 2. Each client's destruction order preserved: provider -> wsProvider -> doc
    const provAIdx = destructionLog.indexOf("providerA");
    const wsAIdx = destructionLog.indexOf("wsProviderA");
    const docAIdx = destructionLog.indexOf("docA");
    expect(provAIdx).toBeLessThan(wsAIdx);
    expect(wsAIdx).toBeLessThan(docAIdx);

    const provBIdx = destructionLog.indexOf("providerB");
    const wsBIdx = destructionLog.indexOf("wsProviderB");
    const docBIdx = destructionLog.indexOf("docB");
    expect(provBIdx).toBeLessThan(wsBIdx);
    expect(wsBIdx).toBeLessThan(docBIdx);

    // 3. Every resource attempted exactly once
    expect(destructionLog.filter((x) => x === "providerA")).toHaveLength(1);
    expect(destructionLog.filter((x) => x === "wsProviderA")).toHaveLength(1);
    expect(destructionLog.filter((x) => x === "docA")).toHaveLength(1);
    expect(destructionLog.filter((x) => x === "providerB")).toHaveLength(1);
    expect(destructionLog.filter((x) => x === "wsProviderB")).toHaveLength(1);
    expect(destructionLog.filter((x) => x === "docB")).toHaveLength(1);
  });

  it("successfully connects and authenticates guest via signed guest cookie", async () => {
    const ownerId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    await UserModel.create({
      _id: ownerId,
      email: "owner@pairprep.com",
      displayName: "Room Owner",
      role: "user",
      provider: "github",
      providerId: `gh_${Date.now()}`,
    });

    await RoomModel.create({
      _id: roomId,
      title: "Guest Smoke Room",
      slug: "guest-smoke-room-slug",
      type: "practice",
      status: "open",
      ownerId,
      language: "python",
    });

    const guest = await guestRepo.createGuest("Guest Candidate", roomId);
    await RoomMemberModel.create({
      roomId,
      memberId: guest.id,
      displayName: "Guest Candidate",
      role: "editor",
      joinedAt: new Date(),
    });

    const guestCookie = `pairprep.guest=${signGuestCookie(guest.id)}`;

    class GuestWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: guestCookie,
          },
        });
      }
    }

    const doc = new Y.Doc();
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: GuestWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Guest connection timed out")),
        5000
      );

      provider.on("authenticated", () => {
        clearTimeout(timer);
        resolve();
      });

      provider.on("authenticationFailed", (data: { reason: string }) => {
        clearTimeout(timer);
        reject(new Error(`Guest auth failed: ${data.reason}`));
      });

      provider.attach();
    });

    expect(wsProvider.status).toBe(WebSocketStatus.Connected);
  });

  it("rejects unauthenticated connection attempts and triggers authenticationFailed", async () => {
    const roomId = new mongoose.Types.ObjectId().toHexString();

    class UnauthenticatedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            // Zero authentication cookies supplied
          },
        });
      }
    }

    const doc = new Y.Doc();
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: UnauthenticatedWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: roomId,
      document: doc,
    });
    providersToCleanup.push(provider);

    const failureReason = await new Promise<string>((resolve) => {
      provider.on("authenticationFailed", (data: { reason: string }) => {
        resolve(data.reason);
      });
      provider.attach();
    });

    // Server throws "Authentication failed: unauthenticated", surfaced as failure reason
    expect(failureReason).toBe("unauthenticated");
  });

  it("server rejects room slug when used as document name instead of MongoDB ObjectId", async () => {
    class SlugWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
          },
        });
      }
    }

    const doc = new Y.Doc();
    const wsProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: SlugWebSocket as unknown as typeof WebSocket,
    });
    wsProvidersToCleanup.push(wsProvider);

    const provider = new HocuspocusProvider({
      websocketProvider: wsProvider,
      name: "practice-round-1-slug", // Room URL slug is not a valid 24-hex ObjectId
      document: doc,
    });
    providersToCleanup.push(provider);

    const failureReason = await new Promise<string>((resolve) => {
      provider.on("authenticationFailed", (data: { reason: string }) => {
        resolve(data.reason);
      });
      provider.attach();
    });

    expect(failureReason).toBe("permission-denied");
  });
});
