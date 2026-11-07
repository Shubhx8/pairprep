import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import mongoose from "mongoose";
import * as Y from "yjs";
import WebSocket from "ws";
import request from "supertest";
import type session from "express-session";
import app from "../../index.js";
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

async function createTestSession(userId: string, sid: string): Promise<string> {
  const store = getSessionStore();
  await new Promise<void>((resolve, reject) => {
    store!.set(
      sid,
      {
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
        passport: { user: userId },
      } as unknown as session.SessionData,
      (err) => (err ? reject(err) : resolve())
    );
  });
  return `${SESSION_COOKIE_NAME}=${signCookieValue(sid, config.SESSION_SECRET!)}`;
}

describe("T07 Live Room Permission Coordination (ED-6, ROOM-3, ROOM-6)", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  const providers: HocuspocusProvider[] = [];
  const wsProviders: HocuspocusProviderWebsocket[] = [];
  let originalUri: string | undefined;

  beforeAll(async () => {
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_live_perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const testUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testUri;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testUri);
    await ClientMapModel.init();
  });

  afterAll(async () => {
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

  beforeEach(async () => {
    resetPersistenceState();
    syncRegistry.resetAll();
    await UserModel.deleteMany({});
    await RoomModel.deleteMany({});
    await RoomMemberModel.deleteMany({});
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

    await new Promise((r) => setTimeout(r, 150));

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

  it("revokes edit permissions within 1s on already-connected sockets when member is demoted to viewer", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const editorId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "live-perm-room-1";

    await UserModel.create([
      {
        _id: ownerId,
        email: "owner@example.com",
        displayName: "Room Owner",
        role: "user",
        provider: "github",
        providerId: "gh_owner_1",
      },
      {
        _id: editorId,
        email: "editor@example.com",
        displayName: "Room Editor",
        role: "user",
        provider: "github",
        providerId: "gh_editor_1",
      },
    ]);

    await RoomModel.create({
      _id: roomId,
      title: "Live Permission Room",
      slug,
      type: "practice",
      status: "open",
      ownerId,
      language: "javascript",
    });

    const [_ownerMember, editorMember] = await RoomMemberModel.create([
      {
        roomId,
        memberId: ownerId,
        displayName: "Room Owner",
        role: "owner",
        joinedAt: new Date(),
      },
      {
        roomId,
        memberId: editorId,
        displayName: "Room Editor",
        role: "editor",
        joinedAt: new Date(),
      },
    ]);

    const ownerCookie = await createTestSession(ownerId, "owner_sid_1");
    const editorCookie = await createTestSession(editorId, "editor_sid_1");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class EditorWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: editorCookie,
          },
        });
      }
    }

    class OwnerWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: ownerCookie,
          },
        });
      }
    }

    const editorDoc = new Y.Doc({ gc: false });
    const editorWs = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: EditorWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(editorWs);

    const editorProvider = new HocuspocusProvider({
      websocketProvider: editorWs,
      name: roomId,
      document: editorDoc,
    });
    providers.push(editorProvider);

    await new Promise<void>((resolve) => {
      editorProvider.on("authenticated", () => resolve());
      editorProvider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    // Editor writes initial text successfully while still an editor
    editorDoc.getText("code").insert(0, "first editor write;\n");
    await new Promise((r) => setTimeout(r, 200));
    await flushRoom(roomId, true);

    const initialUpdates = await DocUpdateModel.find({ roomId });
    expect(initialUpdates.length).toBeGreaterThan(0);

    // Owner calls REST API to demote Editor to 'viewer'
    const demoteRes = await request(app)
      .patch(`/api/v1/rooms/${slug}/members/${editorMember!.id}`)
      .set("Cookie", [ownerCookie])
      .set("X-Requested-With", "pairprep")
      .send({ role: "viewer" });

    expect(demoteRes.status).toBe(200);
    expect(demoteRes.body.member.role).toBe("viewer");

    // Without reconnecting, editor attempts to type within < 1 second of demotion
    const preEditUpdatesCount = (await DocUpdateModel.find({ roomId })).length;
    editorDoc.getText("code").insert(editorDoc.getText("code").length, "attempted illegal edit;\n");

    await new Promise((r) => setTimeout(r, 300));
    await flushRoom(roomId, true);

    // Edit must NOT be accepted or persisted
    const postEditUpdatesCount = (await DocUpdateModel.find({ roomId })).length;
    expect(postEditUpdatesCount).toBe(preEditUpdatesCount);

    // Connect Owner as well to verify valid editors can still write to the room
    const ownerDoc = new Y.Doc({ gc: false });
    const ownerWs = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: OwnerWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(ownerWs);

    const ownerProvider = new HocuspocusProvider({
      websocketProvider: ownerWs,
      name: roomId,
      document: ownerDoc,
    });
    providers.push(ownerProvider);

    await new Promise<void>((resolve) => {
      ownerProvider.on("authenticated", () => resolve());
      ownerProvider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    ownerDoc.getText("code").insert(ownerDoc.getText("code").length, "owner valid write;\n");
    await new Promise((r) => setTimeout(r, 200));
    await flushRoom(roomId, true);

    const afterOwnerUpdatesCount = (await DocUpdateModel.find({ roomId })).length;
    expect(afterOwnerUpdatesCount).toBeGreaterThan(postEditUpdatesCount);
  });

  it("enables edit permissions on already-connected sockets when member is promoted from viewer to editor", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const memberId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "live-perm-room-promo";

    await UserModel.create([
      {
        _id: ownerId,
        displayName: "Owner",
        role: "user",
        provider: "github",
        providerId: "gh_owner_promo",
      },
      {
        _id: memberId,
        displayName: "Viewer to Editor",
        role: "user",
        provider: "github",
        providerId: "gh_member_promo",
      },
    ]);

    await RoomModel.create({
      _id: roomId,
      title: "Promotion Room",
      slug,
      type: "practice",
      status: "open",
      ownerId,
      language: "javascript",
    });

    const [_ownerMember, viewerMember] = await RoomMemberModel.create([
      {
        roomId,
        memberId: ownerId,
        displayName: "Owner",
        role: "owner",
        joinedAt: new Date(),
      },
      {
        roomId,
        memberId,
        displayName: "Viewer to Editor",
        role: "viewer",
        joinedAt: new Date(),
      },
    ]);

    const ownerCookie = await createTestSession(ownerId, "owner_sid_promo");
    const memberCookie = await createTestSession(memberId, "member_sid_promo");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class MemberWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: memberCookie,
          },
        });
      }
    }

    const memberDoc = new Y.Doc({ gc: false });
    const memberWs = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: MemberWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(memberWs);

    const memberProvider = new HocuspocusProvider({
      websocketProvider: memberWs,
      name: roomId,
      document: memberDoc,
    });
    providers.push(memberProvider);

    await new Promise<void>((resolve) => {
      memberProvider.on("authenticated", () => resolve());
      memberProvider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    // Member is currently viewer, promote via REST
    const promoteRes = await request(app)
      .patch(`/api/v1/rooms/${slug}/members/${viewerMember!.id}`)
      .set("Cookie", [ownerCookie])
      .set("X-Requested-With", "pairprep")
      .send({ role: "editor" });

    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.member.role).toBe("editor");

    // Member types on already-connected socket
    memberDoc.getText("code").insert(0, "promoted editor first write;\n");
    await new Promise((r) => setTimeout(r, 300));
    await flushRoom(roomId, true);

    const updates = await DocUpdateModel.find({ roomId });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]?.authorId).toBe(memberId);
  });

  it("immediately terminates active WebSocket connection when member is kicked via REST API", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const kickedId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "live-kick-room-2";

    await UserModel.create([
      {
        _id: ownerId,
        displayName: "Owner",
        role: "user",
        provider: "github",
        providerId: "gh_owner_2",
      },
      {
        _id: kickedId,
        displayName: "To Be Kicked",
        role: "user",
        provider: "github",
        providerId: "gh_kicked_2",
      },
    ]);

    await RoomModel.create({
      _id: roomId,
      title: "Kick Test Room",
      slug,
      type: "practice",
      status: "open",
      ownerId,
      language: "javascript",
    });

    const [_ownerMember, kickedMember] = await RoomMemberModel.create([
      {
        roomId,
        memberId: ownerId,
        displayName: "Owner",
        role: "owner",
        joinedAt: new Date(),
      },
      {
        roomId,
        memberId: kickedId,
        displayName: "To Be Kicked",
        role: "editor",
        joinedAt: new Date(),
      },
    ]);

    const ownerCookie = await createTestSession(ownerId, "owner_sid_kick");
    const kickedCookie = await createTestSession(kickedId, "kicked_sid_kick");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class KickedWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: kickedCookie,
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const ws = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: KickedWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(ws);

    const provider = new HocuspocusProvider({
      websocketProvider: ws,
      name: roomId,
      document: doc,
    });
    providers.push(provider);

    await new Promise<void>((resolve) => {
      provider.on("authenticated", () => resolve());
      provider.attach();
    });
    // Wait for server to promote reservation
    await new Promise((r) => setTimeout(r, 100));

    expect(syncRegistry.getMemberConnectionCount(roomId, kickedId)).toBe(1);

    // Owner kicks member via REST
    const kickRes = await request(app)
      .delete(`/api/v1/rooms/${slug}/members/${kickedMember!.id}`)
      .set("Cookie", [ownerCookie])
      .set("X-Requested-With", "pairprep");

    expect(kickRes.status).toBe(200);

    // Wait a tick for close event propagation
    await new Promise((r) => setTimeout(r, 200));

    // WebSocket connection must be unregistered and disconnected
    expect(syncRegistry.getMemberConnectionCount(roomId, kickedId)).toBe(0);
  });

  it("locks room to read-only when room is ended via REST API", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "live-end-room-3";

    await UserModel.create({
      _id: ownerId,
      displayName: "Owner",
      role: "user",
      provider: "github",
      providerId: "gh_owner_3",
    });

    await RoomModel.create({
      _id: roomId,
      title: "End Test Room",
      slug,
      type: "practice",
      status: "open",
      ownerId,
      language: "javascript",
    });

    await RoomMemberModel.create({
      roomId,
      memberId: ownerId,
      displayName: "Owner",
      role: "owner",
      joinedAt: new Date(),
    });

    const ownerCookie = await createTestSession(ownerId, "owner_sid_end");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class OwnerWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: ownerCookie,
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const ws = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: OwnerWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(ws);

    const provider = new HocuspocusProvider({
      websocketProvider: ws,
      name: roomId,
      document: doc,
    });
    providers.push(provider);

    await new Promise<void>((resolve) => {
      provider.on("authenticated", () => resolve());
      provider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    // Owner writes initial text
    doc.getText("code").insert(0, "initial text before end;\n");
    await new Promise((r) => setTimeout(r, 200));
    await flushRoom(roomId, true);

    const preEndCount = (await DocUpdateModel.find({ roomId })).length;
    expect(preEndCount).toBeGreaterThan(0);

    // Owner ends session via REST API
    const endRes = await request(app)
      .post(`/api/v1/rooms/${slug}/end`)
      .set("Cookie", [ownerCookie])
      .set("X-Requested-With", "pairprep");

    expect(endRes.status).toBe(200);
    expect(endRes.body.room.status).toBe("ended");
    expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);

    // Any subsequent edit is blocked in read-only mode
    doc.getText("code").insert(doc.getText("code").length, "attempted text after end;\n");
    await new Promise((r) => setTimeout(r, 200));
    await flushRoom(roomId, true);

    const postEndCount = (await DocUpdateModel.find({ roomId })).length;
    expect(postEndCount).toBe(preEndCount);
  });

  it("terminates all active connections and cleans up client mappings when room is deleted via REST API", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "live-delete-room-4";

    await UserModel.create({
      _id: ownerId,
      displayName: "Owner",
      role: "user",
      provider: "github",
      providerId: "gh_owner_del",
    });

    await RoomModel.create({
      _id: roomId,
      title: "Delete Test Room",
      slug,
      type: "practice",
      status: "open",
      ownerId,
      language: "javascript",
    });

    await RoomMemberModel.create({
      roomId,
      memberId: ownerId,
      displayName: "Owner",
      role: "owner",
      joinedAt: new Date(),
    });

    // Populate client mappings
    await clientMapRepo.registerClient(roomId, 7001, ownerId);
    expect((await clientMapRepo.findByRoom(roomId)).length).toBe(1);

    const ownerCookie = await createTestSession(ownerId, "owner_sid_del");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class OwnerWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: ownerCookie,
          },
        });
      }
    }

    const doc = new Y.Doc({ gc: false });
    const ws = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: OwnerWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(ws);

    const provider = new HocuspocusProvider({
      websocketProvider: ws,
      name: roomId,
      document: doc,
    });
    providers.push(provider);

    await new Promise<void>((resolve) => {
      provider.on("authenticated", () => resolve());
      provider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(1);

    // Delete room via REST
    const delRes = await request(app)
      .delete(`/api/v1/rooms/${slug}`)
      .set("Cookie", [ownerCookie])
      .set("X-Requested-With", "pairprep");

    expect(delRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 200));

    // Active sockets closed, room set read-only, client map cleared
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
    expect(syncRegistry.isRoomReadOnly(roomId)).toBe(true);
    expect((await clientMapRepo.findByRoom(roomId)).length).toBe(0);
  });

  it("coordinates interview candidate permissions between open and live lifecycle statuses", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const candidateId = new mongoose.Types.ObjectId().toString();
    const roomId = new mongoose.Types.ObjectId().toString();
    const slug = "interview-lifecycle-room";

    await UserModel.create([
      {
        _id: ownerId,
        displayName: "Interviewer",
        role: "user",
        provider: "github",
        providerId: "gh_interviewer",
      },
      {
        _id: candidateId,
        displayName: "Candidate",
        role: "user",
        provider: "github",
        providerId: "gh_candidate",
      },
    ]);

    await RoomModel.create({
      _id: roomId,
      title: "Technical Interview",
      slug,
      type: "interview",
      status: "open", // Interview hasn't started yet
      ownerId,
      language: "javascript",
    });

    await RoomMemberModel.create([
      {
        roomId,
        memberId: ownerId,
        displayName: "Interviewer",
        role: "interviewer",
        joinedAt: new Date(),
      },
      {
        roomId,
        memberId: candidateId,
        displayName: "Candidate",
        role: "candidate",
        joinedAt: new Date(),
      },
    ]);

    const candidateCookie = await createTestSession(candidateId, "candidate_sid");

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer(app);
    attachSyncServer(httpServer, syncServer);

    const port = await new Promise<number>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        resolve(typeof addr === "object" ? addr!.port : 3000);
      });
    });

    class CandidateWebSocket extends WebSocket {
      constructor(url: string) {
        super(url, {
          headers: {
            origin: "http://localhost:3000",
            cookie: candidateCookie,
          },
        });
      }
    }

    const candidateDoc = new Y.Doc({ gc: false });
    const candidateWs = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/sync`,
      WebSocketPolyfill: CandidateWebSocket as unknown as typeof WebSocket,
    });
    wsProviders.push(candidateWs);

    const candidateProvider = new HocuspocusProvider({
      websocketProvider: candidateWs,
      name: roomId,
      document: candidateDoc,
    });
    providers.push(candidateProvider);

    await new Promise<void>((resolve) => {
      candidateProvider.on("authenticated", () => resolve());
      candidateProvider.attach();
    });
    await new Promise((r) => setTimeout(r, 100));

    // Candidate connected to an 'open' interview room is initially read-only (PRD 13.2)
    const activeConn = Array.from(syncRegistry.getActiveConnectionsForRoom(roomId))[0];
    expect(activeConn?.connection.readOnly).toBe(true);

    // Interview starts: room transitions to 'live'
    syncRegistry.updateRoomLifecycle(roomId, "live");
    expect(activeConn?.connection.readOnly).toBe(false);

    // Candidate can now write
    candidateDoc.getText("code").insert(0, "function solution() { return true; }\n");
    await new Promise((r) => setTimeout(r, 200));
    await flushRoom(roomId, true);

    const updates = await DocUpdateModel.find({ roomId });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]?.authorId).toBe(candidateId);
  });
});
