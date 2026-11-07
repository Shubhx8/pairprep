import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import mongoose from "mongoose";
import * as Y from "yjs";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import WebSocket from "ws";
import { config } from "../../config.js";
import { DocUpdateModel } from "../../models/doc_updates.js";

/**
 * Persistence Crash & Durability Recovery Test (PER-1)
 *
 * How both child processes receive the same MONGODB_URI and test database name:
 * Both child processes (Process A: original server before crash; Process B: restarted server after crash)
 * are spawned via `node:child_process.spawn()` passing the exact same `process.env.MONGODB_URI`
 * inherited from the parent Vitest test runner (which connects to the isolated test database, e.g.
 * `mongodb://127.0.0.1:27017/pairprep-test-<randomId>`).
 * This ensures that when Process A receives writes and is killed with SIGKILL (simulating an abrupt crash),
 * Process B starts up pointing to the exact same MongoDB database and collections (`doc_updates`, `doc_snapshots`),
 * allowing us to verify crash recovery and document state reconstruction up to 2 seconds before the crash.
 */
describe("Persistence Crash Recovery (PER-1)", () => {
  let testMongoUri: string;
  let originalUri: string | undefined;
  const workerScript = path.resolve(__dirname, "crashServerWorker.ts");
  let procA: ChildProcess | null = null;
  let procB: ChildProcess | null = null;

  class BrowserLikeWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[], options?: object) {
      super(url, protocols, {
        ...options,
        headers: {
          origin: "http://localhost:3000",
          ...((options as { headers?: Record<string, string> })?.headers || {}),
        },
      });
    }
  }

  beforeEach(async () => {
    originalUri = config.MONGODB_URI;
    const testDb = `pairprep_crash_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    testMongoUri = `mongodb://127.0.0.1:27017/${testDb}`;
    (config as { MONGODB_URI?: string }).MONGODB_URI = testMongoUri;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(testMongoUri);
  });

  afterEach(async () => {
    if (procA && !procA.killed) {
      procA.kill("SIGKILL");
      procA = null;
    }
    if (procB && !procB.killed) {
      procB.kill("SIGKILL");
      procB = null;
    }

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

  function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  function startWorker(
    envUri: string,
    targetPort: number
  ): Promise<{ proc: ChildProcess; port: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ["--import", "tsx", workerScript],
        {
          env: {
            ...process.env,
            MONGODB_URI: envUri,
            PORT: String(targetPort),
          },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      let stdout = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = stdout.match(/READY:(\d+)/);
        if (match && match[1]) {
          resolve({ proc, port: parseInt(match[1], 10) });
        }
      });

      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(new Error(`Worker exited early with code ${code}: ${stderr}`));
        }
      });
    });
  }

  it("recovers document state upon server crash within the 2-second durability bound", async () => {
    const roomId = "507f1f77bcf86cd799439011";

    // 1. Spawn Process A (passing testMongoUri via MONGODB_URI env var)
    const portA = await getFreePort();
    const { proc: workerA } = await startWorker(testMongoUri, portA);
    procA = workerA;

    const wsUrlA = `ws://127.0.0.1:${portA}/sync`;
    const wsProviderA = new HocuspocusProviderWebsocket({
      url: wsUrlA,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });

    const clientDocA = new Y.Doc();
    const providerA = new HocuspocusProvider({
      websocketProvider: wsProviderA,
      name: roomId,
      document: clientDocA,
    });
    providerA.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connect to Process A timed out")), 5000);
      providerA.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // 2. Perform continuous typing edits
    const textA = clientDocA.getText("monaco");
    textA.insert(0, "CRASH_DURABILITY_TEST_PREFIX_");

    // Wait 2,200 ms to exceed MAX_FLUSH_DEADLINE_MS (2,000 ms) so persistence flush is guaranteed
    await new Promise((r) => setTimeout(r, 2200));

    // Verify updates exist in MongoDB
    const persistedUpdates = await DocUpdateModel.find({ roomId }).exec();
    expect(persistedUpdates.length).toBeGreaterThan(0);

    // 3. Abruptly crash Process A with SIGKILL (no graceful shutdown)
    procA.kill("SIGKILL");
    providerA.destroy();
    wsProviderA.destroy();

    // 4. Spawn Process B (passing the EXACT same MONGODB_URI env var)
    const portB = await getFreePort();
    const { proc: workerB } = await startWorker(testMongoUri, portB);
    procB = workerB;

    const wsUrlB = `ws://127.0.0.1:${portB}/sync`;
    const wsProviderB = new HocuspocusProviderWebsocket({
      url: wsUrlB,
      WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof WebSocket,
    });

    const clientDocB = new Y.Doc();
    const providerB = new HocuspocusProvider({
      websocketProvider: wsProviderB,
      name: roomId,
      document: clientDocB,
    });
    providerB.attach();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connect to Process B timed out")), 5000);
      providerB.on("synced", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // 5. Verify that Process B reconstructed the document state from MongoDB
    const textB = clientDocB.getText("monaco").toString();
    expect(textB).toContain("CRASH_DURABILITY_TEST_PREFIX_");

    providerB.destroy();
    wsProviderB.destroy();
    procB.kill("SIGKILL");
    procB = null;
    procA = null;
  }, 30000);
});
