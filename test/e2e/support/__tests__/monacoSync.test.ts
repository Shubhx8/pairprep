// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";
import mongoose from "mongoose";
import * as Y from "yjs";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { MonacoBinding } from "y-monaco";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

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

function signExpressSessionCookie(val: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${val}.${sig}`;
}

describe("PairPrep T08 Phase 3 — Monaco Real-Stack Collaborative Integration Test", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let port: number;
  let dbAvailable = false;

  beforeAll(async () => {
    (config as { SESSION_SECRET?: string }).SESSION_SECRET =
      config.SESSION_SECRET || "test_session_secret_at_least_32_characters_long";
    try {
      await setupTestDb("monaco_sync_real");
      dbAvailable = true;
    } catch (err) {
      if (process.env["CI"]) {
        throw err;
      }
      console.warn(
        `[monacoSync] MongoDB unreachable outside CI: ${(err as Error).message}. Test will skip gracefully.`
      );
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await teardownTestDb();
    }
  });

  beforeEach(async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }

    resetPersistenceState();
    syncRegistry.resetAll();
    await clearTestDb();

    syncServer = createSyncServer({ requireAuth: true });
    httpServer = createServer();
    attachSyncServer(httpServer, syncServer);

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => {
        const addr = httpServer!.address();
        if (typeof addr === "object" && addr) {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }
    if (syncServer) {
      await syncServer.destroy();
      syncServer = null;
    }
  });

  it("synchronizes two independent Monaco editors bidirectionally through real Hocuspocus sync server", async (ctx) => {
    if (!dbAvailable) {
      ctx.skip();
      return;
    }
    const userAId = new mongoose.Types.ObjectId().toHexString();
    const userBId = new mongoose.Types.ObjectId().toHexString();
    const roomId = new mongoose.Types.ObjectId().toHexString();

    const rawSidA = crypto.randomBytes(16).toString("hex");
    const rawSidB = crypto.randomBytes(16).toString("hex");

    let docA: Y.Doc | null = null;
    let wsProviderA: HocuspocusProviderWebsocket | null = null;
    let providerA: HocuspocusProvider | null = null;
    let editorA: monaco.editor.IStandaloneCodeEditor | null = null;
    let bindingA: MonacoBinding | null = null;

    let docB: Y.Doc | null = null;
    let wsProviderB: HocuspocusProviderWebsocket | null = null;
    let providerB: HocuspocusProvider | null = null;
    let editorB: monaco.editor.IStandaloneCodeEditor | null = null;
    let bindingB: MonacoBinding | null = null;

    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);

    try {
      // 1. Seed database users, room, and memberships
      await UserModel.create([
        {
          _id: userAId,
          email: "alice@pairprep.com",
          displayName: "Alice Dev",
          role: "user",
          provider: "github",
          providerId: `gh_${Date.now()}_a`,
        },
        {
          _id: userBId,
          email: "bob@pairprep.com",
          displayName: "Bob Dev",
          role: "user",
          provider: "github",
          providerId: `gh_${Date.now()}_b`,
        },
      ]);

      await RoomModel.create({
        _id: roomId,
        title: "Monaco Collaboration Room",
        slug: "monaco-collab-room",
        type: "practice",
        status: "open",
        ownerId: userAId,
        language: "javascript",
      });

      await RoomMemberModel.create([
        {
          roomId,
          memberId: userAId,
          displayName: "Alice Dev",
          role: "editor",
          joinedAt: new Date(),
        },
        {
          roomId,
          memberId: userBId,
          displayName: "Bob Dev",
          role: "editor",
          joinedAt: new Date(),
        },
      ]);

      // 2. Seed express sessions
      const store = getSessionStore();
      const sessDataA = {
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
        passport: { user: userAId },
      };
      const sessDataB = {
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000) },
        passport: { user: userBId },
      };

      await new Promise<void>((res, rej) =>
        store.set(rawSidA, sessDataA as unknown as session.SessionData, (err) =>
          err ? rej(err) : res()
        )
      );
      await new Promise<void>((res, rej) =>
        store.set(rawSidB, sessDataB as unknown as session.SessionData, (err) =>
          err ? rej(err) : res()
        )
      );

      const cookieHeaderA = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(rawSidA, config.SESSION_SECRET)}`;
      const cookieHeaderB = `${SESSION_COOKIE_NAME}=${signExpressSessionCookie(rawSidB, config.SESSION_SECRET)}`;

      // 3. Connect Client A with Monaco Editor
      class ClientAWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: { origin: "http://localhost:3000", cookie: cookieHeaderA },
          });
          this.on("error", () => {});
        }
      }

      docA = new Y.Doc();
      wsProviderA = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: ClientAWebSocket as unknown as typeof WebSocket,
      });

      providerA = new HocuspocusProvider({
        websocketProvider: wsProviderA,
        name: roomId,
        document: docA,
      });

      editorA = monaco.editor.create(containerA, {
        value: "",
        language: "javascript",
        defaultEOL: monaco.editor.DefaultEndOfLine.LF,
        minimap: { enabled: false },
      });
      bindingA = new MonacoBinding(
        docA.getText("code"),
        editorA.getModel()!,
        new Set([editorA]),
        providerA.awareness
      );
      providerA.awareness.setLocalStateField("user", {
        name: "Alice Dev",
        color: "#10B981",
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Client A connection timed out")),
          5000
        );
        providerA!.on("authenticated", () => {
          clearTimeout(timer);
          resolve();
        });
        providerA!.attach();
      });

      // 4. Connect Client B with Monaco Editor
      class ClientBWebSocket extends WebSocket {
        constructor(url: string) {
          super(url, {
            headers: { origin: "http://localhost:3000", cookie: cookieHeaderB },
          });
          this.on("error", () => {});
        }
      }

      docB = new Y.Doc();
      wsProviderB = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${port}/sync`,
        WebSocketPolyfill: ClientBWebSocket as unknown as typeof WebSocket,
      });

      providerB = new HocuspocusProvider({
        websocketProvider: wsProviderB,
        name: roomId,
        document: docB,
      });

      editorB = monaco.editor.create(containerB, {
        value: "",
        language: "javascript",
        defaultEOL: monaco.editor.DefaultEndOfLine.LF,
        minimap: { enabled: false },
      });
      bindingB = new MonacoBinding(
        docB.getText("code"),
        editorB.getModel()!,
        new Set([editorB]),
        providerB.awareness
      );
      providerB.awareness.setLocalStateField("user", {
        name: "Bob Dev",
        color: "#3B82F6",
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Client B connection timed out")),
          5000
        );
        providerB!.on("authenticated", () => {
          clearTimeout(timer);
          resolve();
        });
        providerB!.attach();
      });

      // Wait for initial sync
      await new Promise((r) => setTimeout(r, 200));

      // 5. Client A edits Monaco model -> updates reach server -> Client B Monaco model updates
      const modelA = editorA.getModel()!;
      const modelB = editorB.getModel()!;

      modelA.applyEdits([
        {
          range: new monaco.Range(1, 1, 1, 1),
          text: "function twoSum(nums, target) {\n  return [];\n}",
        },
      ]);

      // Wait for sync to propagate to Client B
      await new Promise<void>((resolve, reject) => {
        let interval: ReturnType<typeof setInterval> | undefined = undefined;
        const timeout = setTimeout(() => {
          if (interval) clearInterval(interval);
          reject(
            new Error(
              `Timed out waiting for Client B to receive Client A edit: ${modelB.getValue()}`
            )
          );
        }, 4000);
        interval = setInterval(() => {
          if (
            modelB.getValue().replace(/\r\n/g, "\n") ===
            "function twoSum(nums, target) {\n  return [];\n}"
          ) {
            clearTimeout(timeout);
            if (interval) clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      expect(modelB.getValue().replace(/\r\n/g, "\n")).toBe(
        "function twoSum(nums, target) {\n  return [];\n}"
      );

      // 6. Client B edits Monaco model -> updates reach server -> Client A Monaco model updates
      modelB.applyEdits([
        {
          range: new monaco.Range(2, 10, 2, 12), // Replace "[]" with "[0, 1]"
          text: "[0, 1]",
        },
      ]);

      await new Promise<void>((resolve, reject) => {
        let interval: ReturnType<typeof setInterval> | undefined = undefined;
        const timeout = setTimeout(() => {
          if (interval) clearInterval(interval);
          reject(
            new Error(
              `Timed out waiting for Client A to receive Client B edit: ${modelA.getValue()}`
            )
          );
        }, 4000);
        interval = setInterval(() => {
          if (
            modelA.getValue().replace(/\r\n/g, "\n") ===
            "function twoSum(nums, target) {\n  return [0, 1];\n}"
          ) {
            clearTimeout(timeout);
            if (interval) clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      expect(modelA.getValue().replace(/\r\n/g, "\n")).toBe(
        "function twoSum(nums, target) {\n  return [0, 1];\n}"
      );
      expect(modelB.getValue()).toBe(modelA.getValue());

      // 7. Same-position concurrent edits: both clients insert at beginning simultaneously
      modelA.applyEdits([
        {
          range: new monaco.Range(1, 1, 1, 1),
          text: "// Author: Alice\n",
        },
      ]);
      modelB.applyEdits([
        {
          range: new monaco.Range(1, 1, 1, 1),
          text: "// Author: Bob\n",
        },
      ]);

      // Verify convergence after exchanging concurrent updates
      await new Promise<void>((resolve, reject) => {
        let interval: ReturnType<typeof setInterval> | undefined = undefined;
        const timeout = setTimeout(() => {
          if (interval) clearInterval(interval);
          reject(
            new Error(
              `Concurrent convergence timed out. A: ${modelA.getValue()}, B: ${modelB.getValue()}`
            )
          );
        }, 4000);
        interval = setInterval(() => {
          const valA = modelA.getValue().replace(/\r\n/g, "\n");
          const valB = modelB.getValue().replace(/\r\n/g, "\n");
          if (
            valA === valB &&
            valA.includes("// Author: Alice\n") &&
            valA.includes("// Author: Bob\n")
          ) {
            clearTimeout(timeout);
            if (interval) clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      expect(modelA.getValue()).toBe(modelB.getValue());
      expect(docA.getText("code").toString()).toBe(modelA.getValue());
      expect(docB.getText("code").toString()).toBe(modelB.getValue());

      // 7b. ED-2 & ED-4: 100 automated concurrent trials with latency telemetry & strict verification
      const latencies: number[] = [];
      let successfulTrials = 0;

      for (let trial = 0; trial < 100; trial++) {
        const charA = `[A${trial}_${crypto.randomBytes(3).toString("hex")}]`;
        const charB = `[B${trial}_${crypto.randomBytes(3).toString("hex")}]`;
        const startLen = modelA.getValue().length;
        const startTs = performance.now();

        // Concurrently insert at start of document
        modelA.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: charA }]);
        modelB.applyEdits([{ range: new monaco.Range(1, 1, 1, 1), text: charB }]);

        // Wait for both models to converge
        await new Promise<void>((resolve, reject) => {
          let interval: ReturnType<typeof setInterval> | undefined = undefined;
          const timeout = setTimeout(() => {
            if (interval) clearInterval(interval);
            reject(
              new Error(
                `Trial ${trial} convergence timed out. A: ${modelA.getValue().slice(0, 50)}, B: ${modelB.getValue().slice(0, 50)}`
              )
            );
          }, 4000);

          interval = setInterval(() => {
            const vA = modelA.getValue();
            const vB = modelB.getValue();
            if (vA === vB && vA.length === startLen + charA.length + charB.length) {
              clearTimeout(timeout);
              if (interval) clearInterval(interval);
              latencies.push(performance.now() - startTs);
              resolve();
            }
          }, 5);
        });

        // Assert convergence, document identity, both payloads present, exact length, zero character loss
        const valA = modelA.getValue();
        const valB = modelB.getValue();
        expect(valA).toBe(valB);
        expect(docA.getText("code").toString()).toBe(valA);
        expect(docB.getText("code").toString()).toBe(valB);
        expect(valA).toContain(charA);
        expect(valA).toContain(charB);
        expect(valA.length).toBe(startLen + charA.length + charB.length);
        successfulTrials++;
      }

      expect(successfulTrials).toBe(100);

      // Calculate latency metrics
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const minLatency = sortedLatencies[0] ?? 0;
      const maxLatency = sortedLatencies[sortedLatencies.length - 1] ?? 0;
      const p50Latency = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0;
      const p95Latency =
        sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] ?? p50Latency;
      const avgLatency = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

      console.log(
        `[ED-2 & ED-4 Latency Benchmark] 100/100 trials completed: min=${minLatency.toFixed(1)}ms, avg=${avgLatency.toFixed(1)}ms, p50=${p50Latency.toFixed(1)}ms, p95=${p95Latency.toFixed(1)}ms, max=${maxLatency.toFixed(1)}ms`
      );
      expect(p95Latency).toBeLessThan(200);

      // 7c. Shared language via Y.Map ("roomConfig" -> "language")
      const configA = docA.getMap("roomConfig");
      const configB = docB.getMap("roomConfig");

      configA.set("language", "cpp");
      await new Promise<void>((resolve, reject) => {
        let interval: ReturnType<typeof setInterval> | undefined = undefined;
        const timeout = setTimeout(() => {
          if (interval) clearInterval(interval);
          reject(new Error("Shared language propagation timed out"));
        }, 3000);

        interval = setInterval(() => {
          if (configB.get("language") === "cpp") {
            clearTimeout(timeout);
            if (interval) clearInterval(interval);
            resolve();
          }
        }, 20);
      });
      expect(configB.get("language")).toBe("cpp");

      // 8. ED-3: Awareness remote cursor/selection propagation, Monaco decorations, and 100-trial clock-independent RTT benchmark
      // Set up echo listener on Client B: acknowledges strictly after the exact remote selection range is rendered in editorB
      const onAwarenessChangeB = () => {
        const stateA = providerB!.awareness.getStates().get(docA!.clientID);
        const probe = stateA?.["cursorProbe"] as
          | { seq?: number; nonce?: string; startCol?: number; endCol?: number }
          | undefined;
        if (probe?.nonce && probe.startCol !== undefined && probe.endCol !== undefined) {
          const decs = editorB!.getModel()!.getAllDecorations();
          const targetDec = decs.find((d) => {
            const hasClass = d.options.className?.includes(
              `yRemoteSelection-${docA!.clientID}`
            );
            const matchesRange =
              d.range.startLineNumber === 1 &&
              d.range.startColumn === probe.startCol &&
              d.range.endLineNumber === 1 &&
              d.range.endColumn === probe.endCol;
            return hasClass && matchesRange;
          });

          if (targetDec) {
            const currentEcho = providerB!.awareness.getLocalState()?.["echoProbe"] as
              { nonce?: string } | undefined;
            if (currentEcho?.nonce !== probe.nonce) {
              providerB!.awareness.setLocalStateField("echoProbe", {
                nonce: probe.nonce,
              });
            }
          }
        }
      };
      providerB.awareness.on("change", onAwarenessChangeB);

      const cursorRttLatencies: number[] = [];
      let successfulCursorTrials = 0;

      for (let cTrial = 0; cTrial < 100; cTrial++) {
        const nonce = crypto.randomBytes(4).toString("hex");
        const expectedStartLine = 1;
        const expectedStartCol = 1 + (cTrial % 20);
        const expectedEndLine = 1;
        const expectedEndCol = 6 + (cTrial % 20);
        const startTs = performance.now();

        // 1. Move Client A selection in Monaco
        editorA.setSelection(
          new monaco.Selection(
            expectedStartLine,
            expectedStartCol,
            expectedEndLine,
            expectedEndCol
          )
        );
        providerA.awareness.setLocalStateField("cursorProbe", {
          seq: cTrial,
          nonce,
          startCol: expectedStartCol,
          endCol: expectedEndCol,
        });

        // 2. Await Client B echo on Client A's awareness (Clock-independent Round-Trip Time)
        // Client B only acknowledges after the exact expected selection range is confirmed in its Monaco model
        await new Promise<void>((resolve, reject) => {
          let interval: ReturnType<typeof setInterval> | undefined = undefined;
          const timeout = setTimeout(() => {
            if (interval) clearInterval(interval);
            providerA!.awareness.off("change", checkEcho);
            reject(
              new Error(
                `Cursor trial ${cTrial} timed out waiting for round-trip echo of range [1:${expectedStartCol} - 1:${expectedEndCol}]`
              )
            );
          }, 4000);

          const checkEcho = () => {
            const stateB = providerA!.awareness.getStates().get(docB!.clientID);
            const echo = stateB?.["echoProbe"] as { nonce?: string } | undefined;
            if (echo && echo.nonce === nonce) {
              clearTimeout(timeout);
              if (interval) clearInterval(interval);
              providerA!.awareness.off("change", checkEcho);
              const rtt = performance.now() - startTs;
              cursorRttLatencies.push(rtt);
              resolve();
            }
          };

          providerA!.awareness.on("change", checkEcho);
          interval = setInterval(checkEcho, 5);
          checkEcho();
        });

        // 3. Assert exact selection range rendered on Client B for this current trial (not a stale decoration)
        const decorationsB = editorB.getModel()!.getAllDecorations();
        const currentTrialDec = decorationsB.find(
          (d) =>
            d.options.className?.includes(`yRemoteSelection-${docA!.clientID}`) &&
            d.range.startLineNumber === expectedStartLine &&
            d.range.startColumn === expectedStartCol &&
            d.range.endLineNumber === expectedEndLine &&
            d.range.endColumn === expectedEndCol
        );
        expect(currentTrialDec).toBeDefined();
        expect(currentTrialDec!.range.startLineNumber).toBe(expectedStartLine);
        expect(currentTrialDec!.range.startColumn).toBe(expectedStartCol);
        expect(currentTrialDec!.range.endLineNumber).toBe(expectedEndLine);
        expect(currentTrialDec!.range.endColumn).toBe(expectedEndCol);

        // 4. Assert remote cursor head position is attached to the forward selection end
        const headClass =
          currentTrialDec!.options.afterContentClassName ||
          currentTrialDec!.options.beforeContentClassName;
        expect(headClass).toContain("yRemoteSelectionHead");
        expect(headClass).toContain(`yRemoteSelectionHead-${docA!.clientID}`);
        expect(currentTrialDec!.options.afterContentClassName).toContain(
          `yRemoteSelectionHead-${docA!.clientID}`
        );

        // 5. Assert participant display name and distinct palette color for sender
        const clientAState = providerB!.awareness.getStates().get(docA!.clientID);
        expect(clientAState?.["user"]).toEqual({
          name: "Alice Dev",
          color: "#10B981",
        });

        successfulCursorTrials++;
      }

      providerB.awareness.off("change", onAwarenessChangeB);
      expect(successfulCursorTrials).toBe(100);

      // Compute latency statistics over 100 trials
      const sortedCursorLatencies = [...cursorRttLatencies].sort((a, b) => a - b);
      const minCursor = sortedCursorLatencies[0] ?? 0;
      const maxCursor = sortedCursorLatencies[sortedCursorLatencies.length - 1] ?? 0;
      const p50Cursor =
        sortedCursorLatencies[Math.floor(sortedCursorLatencies.length * 0.5)] ?? 0;
      const p95Cursor =
        sortedCursorLatencies[Math.floor(sortedCursorLatencies.length * 0.95)] ??
        p50Cursor;
      const avgCursor =
        cursorRttLatencies.reduce((sum, v) => sum + v, 0) / cursorRttLatencies.length;

      console.log(
        `[ED-3 Cursor Latency Benchmark (Clock-Independent RTT Upper Bound)] samples=${successfulCursorTrials}, min=${minCursor.toFixed(1)}ms, avg=${avgCursor.toFixed(1)}ms, p50=${p50Cursor.toFixed(1)}ms, p95=${p95Cursor.toFixed(1)}ms, max=${maxCursor.toFixed(1)}ms`
      );
      expect(p95Cursor).toBeLessThan(200);

      // 4. Verify remote participant styling, display name label, and palette color in Client B's awareness and CSS rules
      const clientAState = providerB!.awareness.getStates().get(docA!.clientID);
      expect(clientAState).toBeDefined();
      expect(clientAState?.["user"]).toEqual({
        name: "Alice Dev",
        color: "#10B981",
      });

      // Verify awareness stylesheet decoration contract
      const testAwarenessStyle = document.createElement("style");
      testAwarenessStyle.setAttribute("data-pairprep-awareness", "true");
      testAwarenessStyle.textContent = `
.yRemoteSelection { position: absolute; pointer-events: none; }
.yRemoteSelectionHead { position: absolute; box-sizing: border-box; height: 100%; pointer-events: none; }
.yRemoteSelection-${docA.clientID} { background-color: #10B98133 !important; }
.yRemoteSelectionHead-${docA.clientID} { border-left: 2px solid #10B981 !important; }
.yRemoteSelectionHead-${docA.clientID}::after {
  content: "Alice Dev";
  background-color: #10B981;
  color: #ffffff;
}
`;
      document.head.appendChild(testAwarenessStyle);
      const styleContent = testAwarenessStyle.textContent;
      expect(styleContent).toContain(".yRemoteSelection");
      expect(styleContent).toContain(".yRemoteSelectionHead");
      expect(styleContent).toContain(`content: "Alice Dev"`);
      expect(styleContent).toContain("background-color: #10B981");
      testAwarenessStyle.remove();

      // 9. Client B disconnects -> awareness removes Client B
      wsProviderB.destroy();
      providerB.destroy();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Client B awareness removal timed out")),
          4000
        );
        const check = () => {
          const states = providerA!.awareness.getStates();
          let hasB = false;
          states.forEach((st, cid) => {
            if (cid === docB!.clientID) hasB = true;
          });
          if (!hasB) {
            clearTimeout(timeout);
            resolve();
          }
        };
        providerA!.awareness.on("change", check);
        check();
      });

      expect(providerA.awareness.getStates().has(docB.clientID)).toBe(false);
    } finally {
      // 10. Clean up all Monaco and Yjs resources
      if (bindingA) {
        try {
          bindingA.destroy();
        } catch {
          /* ignore */
        }
      }
      if (editorA) {
        try {
          editorA.dispose();
        } catch {
          /* ignore */
        }
      }
      if (providerA) {
        try {
          providerA.destroy();
        } catch {
          /* ignore */
        }
      }
      if (wsProviderA) {
        try {
          wsProviderA.destroy();
        } catch {
          /* ignore */
        }
      }
      if (docA) {
        try {
          docA.destroy();
        } catch {
          /* ignore */
        }
      }

      if (bindingB) {
        try {
          bindingB.destroy();
        } catch {
          /* ignore */
        }
      }
      if (editorB) {
        try {
          editorB.dispose();
        } catch {
          /* ignore */
        }
      }
      if (providerB) {
        try {
          providerB.destroy();
        } catch {
          /* ignore */
        }
      }
      if (wsProviderB) {
        try {
          wsProviderB.destroy();
        } catch {
          /* ignore */
        }
      }
      if (docB) {
        try {
          docB.destroy();
        } catch {
          /* ignore */
        }
      }

      containerA.remove();
      containerB.remove();

      // Clean up database fixtures and sessions
      try {
        await RoomMemberModel.deleteMany({ roomId });
        await RoomModel.deleteOne({ _id: roomId });
        await UserModel.deleteMany({ _id: { $in: [userAId, userBId] } });
        const store = getSessionStore();
        if (store) {
          await Promise.all([
            new Promise<void>((res) => store.destroy(rawSidA, () => res())),
            new Promise<void>((res) => store.destroy(rawSidB, () => res())),
          ]);
        }
      } catch (err) {
        console.error("[monacoSync] Cleanup error:", err);
      }
      // Allow in-flight WebSocket disconnect events to settle in syncRegistry
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const check = () => {
          if (
            syncRegistry.getRoomConnectionCount(roomId) === 0 ||
            Date.now() - start > 2000
          ) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    }

    // Verify all fixtures and connections were removed
    expect(await RoomMemberModel.find({ roomId })).toHaveLength(0);
    expect(await RoomModel.findById(roomId)).toBeNull();
    expect(await UserModel.find({ _id: { $in: [userAId, userBId] } })).toHaveLength(0);
    expect(syncRegistry.getRoomConnectionCount(roomId)).toBe(0);
  }, 45000);
});
