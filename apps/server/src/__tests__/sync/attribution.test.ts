import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import mongoose from "mongoose";
import * as Y from "yjs";
import WebSocket from "ws";
import type session from "express-session";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { resetPersistenceState, flushRoom } from "../../sync/persistence.js";
import { clientMapRepo } from "../../repos/clientMapRepo.js";
import { ClientMapModel } from "../../models/client_map.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { UserModel } from "../../models/users.js";
import { RoomModel } from "../../models/rooms.js";
import { RoomMemberModel } from "../../models/room_members.js";
import { SESSION_COOKIE_NAME, getSessionStore } from "../../middleware/session.js";
import { config } from "../../config.js";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";

function signCookieValue(val: string, secret: string): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${hmac}`;
}

describe("T07 Client Identity Attribution (ATTR-1)", () => {
  const roomId = "507f1f77bcf86cd799439011";
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];
  let originalUri: string | undefined;

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_attr_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await ClientMapModel.init(); // Ensure unique compound index is created
    await ClientMapModel.deleteMany({});
    await DocUpdateModel.deleteMany({});
  });

  afterEach(async () => {
    for (const p of providers) {
      try {
        p.destroy();
      } catch {
        // ignore
      }
    }
    providers.length = 0;

    for (const ws of wsProviders) {
      try {
        ws.destroy();
      } catch {
        // ignore
      }
    }
    wsProviders.length = 0;

    // Allow in-flight disconnect hooks to settle before stopping server and database
    await new Promise((r) => setTimeout(r, 100));

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

    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db?.dropDatabase();
      } catch {
        // ignore
      }
      await mongoose.disconnect();
    }
    (config as { MONGODB_URI?: string }).MONGODB_URI = originalUri;
  });

  describe("ClientMapRepo Unit & Concurrency (First-Claim-Wins)", () => {
    it("successfully registers a legitimate new clientId for an authenticated actor", async () => {
      const result = await clientMapRepo.registerClient(roomId, 1001, "user_alice");

      expect(result.isNew).toBe(true);
      expect(result.isConflict).toBe(false);
      expect(result.record).not.toBeNull();
      expect(result.record?.roomId).toBe(roomId);
      expect(result.record?.clientId).toBe(1001);
      expect(result.record?.actorId).toBe("user_alice");

      const inDb = await ClientMapModel.findOne({ roomId, clientId: 1001 });
      expect(inDb).not.toBeNull();
      expect(inDb?.actorId).toBe("user_alice");
    });

    it("is idempotent when the same actor re-registers the same clientId", async () => {
      const first = await clientMapRepo.registerClient(roomId, 1002, "user_alice");
      expect(first.isNew).toBe(true);
      expect(first.isConflict).toBe(false);

      const second = await clientMapRepo.registerClient(roomId, 1002, "user_alice");
      expect(second.isNew).toBe(false);
      expect(second.isConflict).toBe(false);
      expect(second.record?.actorId).toBe("user_alice");

      const count = await ClientMapModel.countDocuments({ roomId, clientId: 1002 });
      expect(count).toBe(1);
    });

    it("enforces first-claim-wins when a second actor attempts to claim an existing clientId", async () => {
      // Alice claims 1003 first
      const aliceClaim = await clientMapRepo.registerClient(roomId, 1003, "user_alice");
      expect(aliceClaim.isNew).toBe(true);
      expect(aliceClaim.isConflict).toBe(false);

      // Eve attempts to claim the same clientId 1003 in the same room
      const eveClaim = await clientMapRepo.registerClient(roomId, 1003, "user_eve_imposter");
      expect(eveClaim.isConflict).toBe(true);
      expect(eveClaim.isNew).toBe(false);
      expect(eveClaim.record?.actorId).toBe("user_alice");

      // Verify the database record STILL belongs to Alice
      const inDb = await ClientMapModel.findOne({ roomId, clientId: 1003 });
      expect(inDb?.actorId).toBe("user_alice");
    });

    it("allows different actors to have identical clientIds across DIFFERENT rooms", async () => {
      const room2 = "507f1f77bcf86cd799439022";
      const res1 = await clientMapRepo.registerClient(roomId, 9999, "user_alice");
      const res2 = await clientMapRepo.registerClient(room2, 9999, "user_bob");

      expect(res1.isNew).toBe(true);
      expect(res2.isNew).toBe(true);
      expect(res1.record?.actorId).toBe("user_alice");
      expect(res2.record?.actorId).toBe("user_bob");
    });

    it("handles concurrent registration races cleanly using atomic $setOnInsert and unique index", async () => {
      const targetClientId = 5555;
      const actors = ["actor_1", "actor_2", "actor_3", "actor_4", "actor_5"];

      // Fire 5 concurrent registrations for the same (roomId, clientId)
      const results = await Promise.all(
        actors.map((actorId) => clientMapRepo.registerClient(roomId, targetClientId, actorId))
      );

      // Exactly one actor must have isNew: true and isConflict: false
      const winner = results.find((r) => r.isNew && !r.isConflict);
      expect(winner).toBeDefined();

      const winningActor = winner!.record?.actorId;
      expect(winningActor).toBeDefined();

      // All other actors must report isConflict: true
      const losers = results.filter((r) => r.isConflict);
      expect(losers.length).toBe(4);

      // Database must have exactly one document for that clientId with the winning actor
      const docs = await ClientMapModel.find({ roomId, clientId: targetClientId });
      expect(docs.length).toBe(1);
      expect(docs[0]!.actorId).toBe(winningActor);
    });

    it("findByClient finds existing mapping and deleteByRoom removes all room mappings", async () => {
      await clientMapRepo.registerClient(roomId, 2001, "user_alice");
      await clientMapRepo.registerClient(roomId, 2002, "user_bob");

      const found = await clientMapRepo.findByClient(roomId, 2001);
      expect(found?.actorId).toBe("user_alice");

      const notFound = await clientMapRepo.findByClient(roomId, 9999);
      expect(notFound).toBeNull();

      const deletedCount = await clientMapRepo.deleteByRoom(roomId);
      expect(deletedCount).toBe(2);

      const remaining = await ClientMapModel.countDocuments({ roomId });
      expect(remaining).toBe(0);
    });
  });

  describe("End-to-End WebSocket Hocuspocus Attribution & Forged Update Defense", () => {
    it("attributes edits to authenticated context and rejects identity hijacking via forged Yjs clientIds", async () => {
      // 1. Seed two real users, a room, and memberships in MongoDB
      const aliceId = new mongoose.Types.ObjectId().toString();
      const eveId = new mongoose.Types.ObjectId().toString();

      await UserModel.create([
        {
          _id: aliceId,
          email: "alice@example.com",
          displayName: "Alice Legitimate",
          role: "user",
          provider: "github",
          providerId: "gh_alice",
        },
        {
          _id: eveId,
          email: "eve@example.com",
          displayName: "Eve Imposter",
          role: "user",
          provider: "github",
          providerId: "gh_eve",
        },
      ]);

      await RoomModel.create({
        _id: roomId,
        title: "Attribution Test Room",
        slug: "attr-test-room",
        type: "practice",
        status: "open",
        ownerId: aliceId,
        language: "javascript",
      });

      await RoomMemberModel.create([
        {
          roomId,
          memberId: aliceId,
          displayName: "Alice Legitimate",
          role: "editor",
          joinedAt: new Date(),
        },
        {
          roomId,
          memberId: eveId,
          displayName: "Eve Imposter",
          role: "editor",
          joinedAt: new Date(),
        },
      ]);

      // Seed valid sessions for Alice and Eve using getSessionStore
      const store = getSessionStore();
      expect(store).not.toBeNull();

      const aliceSid = "alice-session-token-xyz";
      const eveSid = "eve-session-token-xyz";

      await new Promise<void>((resolve, reject) => {
        store!.set(
          aliceSid,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: aliceId },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      });

      await new Promise<void>((resolve, reject) => {
        store!.set(
          eveSid,
          {
            cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
            passport: { user: eveId },
          } as unknown as session.SessionData,
          (err) => (err ? reject(err) : resolve())
        );
      });

      const aliceCookie = `${SESSION_COOKIE_NAME}=${signCookieValue(
        aliceSid,
        config.SESSION_SECRET!
      )}`;
      const eveCookie = `${SESSION_COOKIE_NAME}=${signCookieValue(
        eveSid,
        config.SESSION_SECRET!
      )}`;

      // 2. Start Sync Server with requireAuth = true
      syncServer = createSyncServer({ requireAuth: true });
      httpServer = createServer();
      attachSyncServer(httpServer, syncServer);

      const port = await new Promise<number>((resolve) => {
        httpServer!.listen(0, "127.0.0.1", () => {
          const addr = httpServer!.address();
          resolve(typeof addr === "object" ? addr!.port : 3000);
        });
      });

      class AliceWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: aliceCookie,
            },
          });
        }
      }

      class EveWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: eveCookie,
            },
          });
        }
      }

      // 3. Connect Alice via HocuspocusProvider
      const aliceDoc = new Y.Doc({ gc: false });
      const aliceWs = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: AliceWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(aliceWs);

      const aliceProvider = new HocuspocusProvider({
        websocketProvider: aliceWs,
        name: roomId,
        document: aliceDoc,
      });
      providers.push(aliceProvider);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Alice connection timed out")), 4000);
        aliceProvider.on("authenticated", () => {
          clearTimeout(timeout);
          resolve();
        });
        aliceProvider.on("authenticationFailed", (data: { reason: string }) => {
          clearTimeout(timeout);
          reject(new Error(`Alice auth failed: ${data.reason}`));
        });
        aliceProvider.attach();
      });

      // Alice sets awareness and types
      aliceProvider.setAwarenessField("user", { name: "Alice" });
      aliceDoc.getText("code").insert(0, "console.log('Alice writes code');\n");

      // Give server time to handle awareness and update
      await new Promise((r) => setTimeout(r, 400));
      await flushRoom(roomId, true);

      // Verify Alice's client_map record exists and is registered to Alice
      const aliceClientMap = await ClientMapModel.findOne({ roomId, clientId: aliceDoc.clientID });
      expect(aliceClientMap).not.toBeNull();
      expect(aliceClientMap?.actorId).toBe(aliceId);

      // Verify doc_updates has Alice's edit attributed to aliceId
      const aliceUpdates = await DocUpdateModel.find({ roomId });
      expect(aliceUpdates.length).toBeGreaterThan(0);
      expect(aliceUpdates[0]!.authorId).toBe(aliceId);

      // 4. Connect Eve (Imposter) attempting to hijack Alice's identity
      const eveDoc = new Y.Doc({ gc: false });
      const eveWs = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: EveWebSocket as unknown as typeof WebSocket,
      });
      wsProviders.push(eveWs);

      const eveProvider = new HocuspocusProvider({
        websocketProvider: eveWs,
        name: roomId,
        document: eveDoc,
      });
      providers.push(eveProvider);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Eve connection timed out")), 4000);
        eveProvider.on("authenticated", () => {
          clearTimeout(timeout);
          resolve();
        });
        eveProvider.on("authenticationFailed", (data: { reason: string }) => {
          clearTimeout(timeout);
          reject(new Error(`Eve auth failed: ${data.reason}`));
        });
        eveProvider.attach();
      });

      // Eve attempts to claim Alice's clientID via awareness directly
      eveProvider.awareness?.setLocalStateField("user", { name: "Eve Pretending To Be Alice" });
      // Eve attempts to register Alice's clientID
      await clientMapRepo.registerClient(roomId, aliceDoc.clientID, eveId);

      // Eve types an edit
      eveDoc.getText("code").insert(eveDoc.getText("code").length, "console.log('Eve writes code');\n");

      await new Promise((r) => setTimeout(r, 400));
      await flushRoom(roomId, true);

      // CRITICAL SECURITY ASSERTION 1:
      // In client_map, Alice's clientID remains strictly mapped to Alice (first-claim-wins)
      const postEveClientMap = await ClientMapModel.findOne({ roomId, clientId: aliceDoc.clientID });
      expect(postEveClientMap).not.toBeNull();
      expect(postEveClientMap?.actorId).toBe(aliceId); // NOT eveId!

      // CRITICAL SECURITY ASSERTION 2:
      // In doc_updates, Eve's edit is attributed to eveId (derived strictly from server authenticated session context),
      // NEVER from any client-supplied claims!
      const allUpdates = await DocUpdateModel.find({ roomId }).sort({ seq: 1 });
      const eveEdits = allUpdates.filter((u) => u.authorId === eveId);
      expect(eveEdits.length).toBeGreaterThan(0);
      expect(eveEdits[0]!.authorId).toBe(eveId); // Attributed to Eve!
    });
  });
});
