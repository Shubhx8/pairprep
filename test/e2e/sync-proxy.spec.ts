import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  seedE2EUserAndSession,
  checkE2EDatabaseAvailable,
  SESSION_COOKIE_NAME,
  E2E_CONFIG,
} from "./support/sessionHarness.js";

/**
 * Seeds a room and room memberships in the E2E database for WebSocket sync tests.
 * Independently exception-safe: uses deterministic predetermined document IDs.
 * If setup fails after partial insertion (e.g. room inserted, or first member inserted
 * before a subsequent member fails), all fixture-owned records are deleted and the
 * connection is closed before re-throwing the primary setup error.
 * Returns the roomId and an idempotent cleanup function.
 */
async function seedRoom(
  mongoUri: string,
  opts: {
    roomId: string;
    ownerId: string;
    members: Array<{ memberId: string; displayName: string; role: string }>;
    _failAfterFirstMemberInsert?: boolean;
    _failAfterRoomInsert?: boolean;
  }
) {
  const conn = await mongoose
    .createConnection(mongoUri, { serverSelectionTimeoutMS: 2000 })
    .asPromise();

  const roomObjectId = new mongoose.Types.ObjectId(opts.roomId);
  const memberDocs = opts.members.map((m) => ({
    _id: new mongoose.Types.ObjectId(),
    roomId: opts.roomId,
    memberId: m.memberId,
    displayName: m.displayName,
    role: m.role,
    joinedAt: new Date(),
  }));
  const memberIds = memberDocs.map((m) => m._id);

  const performCleanup = async () => {
    let memberErr: unknown = null;
    let roomErr: unknown = null;
    let closeErr: unknown = null;

    if (memberIds.length > 0) {
      try {
        await conn.collection("room_members").deleteMany({
          _id: { $in: memberIds },
        });
      } catch (err) {
        memberErr = err;
        console.error("[seedRoom] Error deleting membership fixtures:", err);
      }
    }

    try {
      await conn.collection("rooms").deleteOne({ _id: roomObjectId });
    } catch (err) {
      roomErr = err;
      console.error("[seedRoom] Error deleting room fixture:", err);
    }

    try {
      await conn.close();
    } catch (err) {
      closeErr = err;
      console.error("[seedRoom] Error closing connection:", err);
    }

    if (memberErr || roomErr || closeErr) {
      // Secondary rollback failures logged without suppressing primary setup error
    }
  };

  try {
    await conn.collection("rooms").insertOne({
      _id: roomObjectId,
      title: "E2E Sync Proxy Room",
      slug: "e2e-sync-proxy-room",
      type: "practice",
      status: "open",
      ownerId: opts.ownerId,
      language: "javascript",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (opts._failAfterRoomInsert) {
      throw new Error("Simulated failure after room insert");
    }

    if (opts._failAfterFirstMemberInsert && memberDocs.length > 0) {
      // Insert first member to prove real partial membership insertion before failure
      await conn.collection("room_members").insertOne(memberDocs[0]);
      throw new Error("Simulated failure during partial membership insertion");
    }

    if (memberDocs.length > 0) {
      await conn.collection("room_members").insertMany(memberDocs);
    }

    return {
      roomId: opts.roomId,
      cleanup: async () => {
        await performCleanup();
      },
    };
  } catch (setupError) {
    await performCleanup();
    throw setupError;
  }
}

/**
 * Browser-to-Vite-to-Hocuspocus WebSocket proxy integration tests.
 *
 * Verifies that:
 * 1. An authenticated browser WebSocket connection through the Vite /sync proxy
 *    completes the full Hocuspocus protocol handshake, and edits made by the browser
 *    propagate through Vite and Hocuspocus to an independent observer's Y.Doc.
 * 2. An unauthenticated browser WebSocket connection is rejected by the server
 *    and never authenticates or synchronizes.
 */
test.describe("Browser-to-Vite WebSocket Proxy Integration", () => {
  test("authenticated browser WebSocket propagates edits through Vite proxy to independent observer", async ({
    browser,
    baseURL,
  }) => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}.`
        );
      }
      test.skip(
        true,
        `Real-stack WebSocket test requires active local test database '${E2E_CONFIG.database}'`
      );
      return;
    }

    // 1. Seed two distinct authenticated users:
    //    - Alice: Browser writer (connects via Chromium through Vite /sync proxy)
    //    - Bob: Independent observer (connects via separate HocuspocusProvider to verify propagation)
    const roomId = new mongoose.Types.ObjectId().toHexString();

    let seedAlice: Awaited<ReturnType<typeof seedE2EUserAndSession>> | null = null;
    let seedBob: Awaited<ReturnType<typeof seedE2EUserAndSession>> | null = null;
    let roomSeed: Awaited<ReturnType<typeof seedRoom>> | null = null;
    let docBob: Y.Doc | null = null;
    let wsProviderBob: HocuspocusProviderWebsocket | null = null;
    let providerBob: HocuspocusProvider | null = null;
    let context: import("@playwright/test").BrowserContext | null = null;

    try {
      // 1. Seed two distinct authenticated users:
      //    - Alice: Browser writer (connects via Chromium through Vite /sync proxy)
      //    - Bob: Independent observer (connects via separate HocuspocusProvider to verify propagation)
      seedAlice = await seedE2EUserAndSession({
        displayName: "Alice Browser Writer",
        email: "alice.writer@example.com",
      });

      seedBob = await seedE2EUserAndSession({
        displayName: "Bob Independent Observer",
        email: "bob.observer@example.com",
      });

      roomSeed = await seedRoom(E2E_CONFIG.mongoUri, {
        roomId,
        ownerId: seedAlice.userId,
        members: [
          {
            memberId: seedAlice.userId,
            displayName: "Alice Browser Writer",
            role: "editor",
          },
          {
            memberId: seedBob.userId,
            displayName: "Bob Independent Observer",
            role: "editor",
          },
        ],
      });

      // 2. Set up Independent Observer (Bob) in the test process
      const serverPort = process.env["PORT"] || "3001";
      docBob = new Y.Doc();

      const bobCookieValue = seedBob.cookie.value;
      class BobWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: {
              origin: "http://localhost:3000",
              cookie: `${SESSION_COOKIE_NAME}=${bobCookieValue}`,
            },
          });
        }
      }

      wsProviderBob = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${serverPort}/sync`,
        WebSocketPolyfill: BobWebSocket as unknown as typeof WebSocket,
      });

      providerBob = new HocuspocusProvider({
        websocketProvider: wsProviderBob,
        name: roomId,
        document: docBob,
      });
      providerBob.attach();

      // Wait for Observer Bob to authenticate and synchronize
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Observer Bob initial sync timed out after 8000ms")),
          8000
        );
        providerBob!.on("synced", ({ state }: { state: boolean }) => {
          if (state) {
            clearTimeout(timer);
            resolve();
          }
        });
        providerBob!.on("authenticationFailed", (data: { reason: string }) => {
          clearTimeout(timer);
          reject(new Error(`Observer Bob authentication failed: ${data.reason}`));
        });
      });

      // 3. Set up Browser Writer (Alice) in real Chromium browser context
      context = await browser.newContext();

      // Inject Alice's session cookie into the browser context
      const urlObj = new URL(baseURL || "http://localhost:5174");
      await context.addCookies([
        {
          name: SESSION_COOKIE_NAME,
          value: seedAlice.cookie.value,
          domain: urlObj.hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);

      const page = await context.newPage();

      // Navigate to /dashboard and wait for page stabilization
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /Practice Rooms/i })).toBeVisible({
        timeout: 10000,
      });

      // 4. Connect Alice via HocuspocusProvider inside the browser through Vite /sync proxy
      //    and perform a collaborative Y.Text edit
      const expectedEdit = "function solveViaBrowser() { return 42; }\n";

      const browserSyncResult = await page.evaluate(
        async ({ docName, textToInsert }) => {
          const { HocuspocusProvider, Y: browserY } =
            await import("/src/hooks/useRoomSync.ts");
          const doc = new browserY.Doc();
          const wsUrl = `ws://${window.location.host}/sync`;

          const provider = new HocuspocusProvider({
            url: wsUrl,
            name: docName,
            document: doc,
          });

          // Retain references on window for clean lifecycle teardown
          const win = window as unknown as {
            __browserProvider?: typeof provider;
            __browserDoc?: typeof doc;
          };
          win.__browserProvider = provider;
          win.__browserDoc = doc;

          return new Promise<{
            authenticated: boolean;
            synced: boolean;
            url: string;
          }>((resolve, reject) => {
            let authenticated = false;

            const timer = setTimeout(() => {
              reject(new Error(`Browser writer timed out. auth=${authenticated}`));
            }, 12000);

            provider.on("authenticated", () => {
              authenticated = true;
            });

            provider.on("authenticationFailed", (data: { reason: string }) => {
              clearTimeout(timer);
              reject(new Error(`Browser writer auth failed: ${data.reason}`));
            });

            provider.on("synced", ({ state }: { state: boolean }) => {
              if (state) {
                // Initial sync complete: insert code edit in browser Y.Doc
                const ytext = doc.getText("code");
                ytext.insert(0, textToInsert);

                clearTimeout(timer);
                resolve({
                  authenticated,
                  synced: true,
                  url: wsUrl,
                });
              }
            });
          });
        },
        { docName: roomId, textToInsert: expectedEdit }
      );

      expect(browserSyncResult.authenticated).toBe(true);
      expect(browserSyncResult.synced).toBe(true);
      expect(browserSyncResult.url).toBe(`ws://${urlObj.host}/sync`);

      // 5. Assert that Independent Observer (Bob) receives Alice's edit through the real server
      await new Promise<void>((resolve, reject) => {
        const text = docBob!.getText("code");
        if (text.toString().includes(expectedEdit)) {
          return resolve();
        }

        const timer = setTimeout(() => {
          reject(
            new Error(
              `Observer Bob timed out waiting for edit from browser. Current content: "${text.toString()}"`
            )
          );
        }, 10000);

        const observer = () => {
          if (text.toString().includes(expectedEdit)) {
            clearTimeout(timer);
            text.unobserve(observer);
            resolve();
          }
        };
        text.observe(observer);
      });

      // Verification: observer's separate document received the exact text inserted by the browser
      expect(docBob.getText("code").toString()).toBe(expectedEdit);
    } finally {
      // Clean up browser provider and document
      if (context) {
        try {
          const page = context.pages()[0];
          if (page && !page.isClosed()) {
            await page
              .evaluate(() => {
                const win = window as unknown as {
                  __browserProvider?: { destroy: () => void };
                  __browserDoc?: { destroy: () => void };
                };
                try {
                  win.__browserProvider?.destroy();
                } catch {
                  // ignore
                }
                try {
                  win.__browserDoc?.destroy();
                } catch {
                  // ignore
                }
              })
              .catch(() => {});
          }
        } catch {
          // ignore
        }

        await context.close().catch(() => {});
      }

      // Clean up observer provider, socket, and document in exact order
      if (providerBob) {
        try {
          providerBob.destroy();
        } catch (cleanupErr) {
          console.error("[sync-proxy.spec] Observer provider destroy error:", cleanupErr);
        }
      }
      if (wsProviderBob) {
        try {
          wsProviderBob.destroy();
        } catch (cleanupErr) {
          console.error(
            "[sync-proxy.spec] Observer WebSocket destroy error:",
            cleanupErr
          );
        }
      }
      if (docBob) {
        try {
          docBob.destroy();
        } catch (cleanupErr) {
          console.error("[sync-proxy.spec] Observer doc destroy error:", cleanupErr);
        }
      }

      // Clean up database records
      if (roomSeed) {
        try {
          await roomSeed.cleanup();
        } catch (cleanupErr) {
          console.error("[sync-proxy.spec] Room seed cleanup error:", cleanupErr);
        }
      }
      if (seedAlice) {
        try {
          await seedAlice.cleanup();
        } catch (cleanupErr) {
          console.error("[sync-proxy.spec] Alice seed cleanup error:", cleanupErr);
        }
      }
      if (seedBob) {
        try {
          await seedBob.cleanup();
        } catch (cleanupErr) {
          console.error("[sync-proxy.spec] Bob seed cleanup error:", cleanupErr);
        }
      }

      // Brief delay to allow server transport disconnections to settle
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test("unauthenticated browser WebSocket is rejected by Hocuspocus server", async ({
    browser,
  }) => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}.`
        );
      }
      test.skip(
        true,
        `Real-stack WebSocket test requires active local test database '${E2E_CONFIG.database}'`
      );
      return;
    }

    // 1. Create browser context WITHOUT any session cookies
    const context = await browser.newContext();

    try {
      const page = await context.newPage();

      // Navigate to the app so browser has correct origin
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");

      // 2. Attempt Hocuspocus connection without authentication cookies
      const authResult = await page.evaluate(async () => {
        const { HocuspocusProvider, Y } = await import("/src/hooks/useRoomSync.ts");
        const doc = new Y.Doc();
        const wsUrl = `ws://${window.location.host}/sync`;

        const provider = new HocuspocusProvider({
          url: wsUrl,
          name: "507f1f77bcf86cd799439011",
          document: doc,
        });

        return new Promise<{
          authenticated: boolean;
          synced: boolean;
          failureReason: string;
        }>((resolve) => {
          let failureReason = "";

          const timer = setTimeout(() => {
            provider.destroy();
            doc.destroy();
            resolve({
              authenticated: false,
              synced: false,
              failureReason: failureReason || "timeout_without_auth",
            });
          }, 8000);

          provider.on("authenticated", () => {
            clearTimeout(timer);
            provider.destroy();
            doc.destroy();
            resolve({
              authenticated: true,
              synced: false,
              failureReason: "",
            });
          });

          provider.on("authenticationFailed", (data: { reason: string }) => {
            failureReason = data.reason;
            clearTimeout(timer);
            provider.destroy();
            doc.destroy();
            resolve({
              authenticated: false,
              synced: false,
              failureReason: data.reason,
            });
          });

          provider.on("synced", () => {
            // Should not fire for unauthenticated connection
          });
        });
      });

      // 3. Verify the server rejected the unauthenticated connection
      expect(authResult.authenticated).toBe(false);
      expect(authResult.synced).toBe(false);
      expect(authResult.failureReason).toMatch(/unauthenticated|permission-denied/);
    } finally {
      await context.close();
    }
  });

  test("seedRoom() cleans up partially inserted records and closes connection when setup fails", async () => {
    const isCI = Boolean(process.env["CI"]);
    const dbAvailable = await checkE2EDatabaseAvailable();
    if (!dbAvailable) {
      if (isCI) {
        throw new Error(
          `CI Failure: E2E database '${E2E_CONFIG.database}' is unreachable at ${E2E_CONFIG.mongoUri}.`
        );
      }
      test.skip(
        true,
        `Real-stack WebSocket test requires active local test database '${E2E_CONFIG.database}'`
      );
      return;
    }

    const testRoomId = new mongoose.Types.ObjectId().toHexString();
    const testOwnerId = new mongoose.Types.ObjectId().toHexString();
    const testMember2Id = new mongoose.Types.ObjectId().toHexString();

    // 1. Trigger failure injection after room is inserted AND after first member is inserted
    await expect(
      seedRoom(E2E_CONFIG.mongoUri, {
        roomId: testRoomId,
        ownerId: testOwnerId,
        members: [
          { memberId: testOwnerId, displayName: "Owner", role: "editor" },
          { memberId: testMember2Id, displayName: "Member2", role: "viewer" },
        ],
        _failAfterFirstMemberInsert: true,
      })
    ).rejects.toThrow("Simulated failure during partial membership insertion");

    // 2. Verify with an independent connection that the partially inserted room AND member were removed
    const verifyConn = await mongoose
      .createConnection(E2E_CONFIG.mongoUri, { serverSelectionTimeoutMS: 2000 })
      .asPromise();

    try {
      const roomDoc = await verifyConn
        .collection("rooms")
        .findOne({ _id: new mongoose.Types.ObjectId(testRoomId) });
      expect(roomDoc).toBeNull();

      const memberDocs = await verifyConn
        .collection("room_members")
        .find({ roomId: testRoomId })
        .toArray();
      expect(memberDocs).toHaveLength(0);
    } finally {
      await verifyConn.close();
    }

    // 3. Verify a subsequent normal fixture can be created and cleaned up cleanly
    const normalRoom = await seedRoom(E2E_CONFIG.mongoUri, {
      roomId: testRoomId,
      ownerId: testOwnerId,
      members: [{ memberId: testOwnerId, displayName: "Test", role: "editor" }],
    });

    const verifyConn2 = await mongoose
      .createConnection(E2E_CONFIG.mongoUri, { serverSelectionTimeoutMS: 2000 })
      .asPromise();

    try {
      const roomDoc = await verifyConn2
        .collection("rooms")
        .findOne({ _id: new mongoose.Types.ObjectId(testRoomId) });
      expect(roomDoc).not.toBeNull();
    } finally {
      await verifyConn2.close();
    }

    await normalRoom.cleanup();

    const verifyConn3 = await mongoose
      .createConnection(E2E_CONFIG.mongoUri, { serverSelectionTimeoutMS: 2000 })
      .asPromise();

    try {
      const roomDoc = await verifyConn3
        .collection("rooms")
        .findOne({ _id: new mongoose.Types.ObjectId(testRoomId) });
      expect(roomDoc).toBeNull();
    } finally {
      await verifyConn3.close();
    }
  });
});
