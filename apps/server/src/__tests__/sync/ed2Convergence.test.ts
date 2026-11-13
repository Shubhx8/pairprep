import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import * as Y from "yjs";
import WebSocket from "ws";
import {
  attachSyncServer,
  createSyncServer,
  type SyncServerInstance,
} from "../../sync/hocuspocus.js";
import { ConnectionRateLimiter } from "../../sync/connectionRateLimiter.js";
import { syncRegistry } from "../../sync/syncRegistry.js";
import { persistenceTestingHooks } from "../../sync/persistence.js";
import { docSnapshotRepo } from "../../repos/docSnapshotRepo.js";
import { docUpdateRepo } from "../../repos/docUpdateRepo.js";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

/**
 * Seeded pseudo-random number generator (Mulberry32) for deterministic,
 * reproducible operation interleaving and payload generation across trials.
 */
function createPrng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ED-2: Provider-Level Conflict-Free Live Editing Convergence (100 Trials)", () => {
  let httpServer: HttpServer | null = null;
  let syncServer: SyncServerInstance | null = null;
  let wsUrl = "";
  const roomId = "507f1f77bcf86cd799439099"; // valid 24-hex ObjectId

  class TestBrowserWebSocket extends WebSocket {
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

  beforeAll(async () => {
    persistenceTestingHooks.isDbConnectedOverride = () => true;
    vi.spyOn(docSnapshotRepo, "getLatestSnapshot").mockResolvedValue(null);
    vi.spyOn(docUpdateRepo, "getUpdatesSince").mockResolvedValue([]);
    vi.spyOn(docUpdateRepo, "appendUpdate").mockResolvedValue({} as never);
    vi.spyOn(docSnapshotRepo, "createSnapshot").mockResolvedValue({} as never);

    syncRegistry.resetAll();
    const testRateLimiter = new ConnectionRateLimiter({
      maxMessageBurst: 500,
      messageRefillPerSec: 500,
      maxByteBurst: 500_000,
      byteRefillPerSec: 500_000,
    });
    httpServer = createServer();
    syncServer = attachSyncServer(
      httpServer,
      createSyncServer({ requireAuth: false, rateLimiter: testRateLimiter })
    );

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid address");
    wsUrl = `ws://127.0.0.1:${addr.port}/sync`;
  });

  afterAll(async () => {
    persistenceTestingHooks.isDbConnectedOverride = null;
    vi.restoreAllMocks();
    if (syncServer) {
      await syncServer.destroy();
      syncServer = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    syncRegistry.resetAll();
  });

  it("converges with zero character loss in 100 out of 100 automated concurrent trials", async () => {
    const MASTER_SEED = 0xed2_2026;
    const rng = createPrng(MASTER_SEED);

    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const wsA = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: TestBrowserWebSocket as unknown as typeof WebSocket,
    });
    const wsB = new HocuspocusProviderWebsocket({
      url: wsUrl,
      WebSocketPolyfill: TestBrowserWebSocket as unknown as typeof WebSocket,
    });

    const providerA = new HocuspocusProvider({
      websocketProvider: wsA,
      name: roomId,
      document: docA,
    });
    const providerB = new HocuspocusProvider({
      websocketProvider: wsB,
      name: roomId,
      document: docB,
    });

    providerA.attach();
    providerB.attach();

    try {
      // 1. Initial synchronization barrier
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error("Provider A initial sync timed out")),
            10000
          );
          if (providerA.isSynced) {
            clearTimeout(t);
            return resolve();
          }
          providerA.on("synced", ({ state }: { state: boolean }) => {
            if (state) {
              clearTimeout(t);
              resolve();
            }
          });
        }),
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error("Provider B initial sync timed out")),
            10000
          );
          if (providerB.isSynced) {
            clearTimeout(t);
            return resolve();
          }
          providerB.on("synced", ({ state }: { state: boolean }) => {
            if (state) {
              clearTimeout(t);
              resolve();
            }
          });
        }),
      ]);

      const TOTAL_TRIALS = 100;
      let convergedCount = 0;
      let divergentCount = 0;
      let missingCharactersCount = 0;

      const waitForConvergence = (
        expectedPredicate: (a: string, b: string) => boolean,
        timeoutMs = 6000
      ): Promise<void> => {
        return new Promise((resolve, reject) => {
          const textA = docA.getText("code");
          const textB = docB.getText("code");

          if (expectedPredicate(textA.toString(), textB.toString())) {
            return resolve();
          }

          const timeoutTimer = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                `Convergence timeout (${timeoutMs}ms). DocA: "${textA.toString()}" vs DocB: "${textB.toString()}"`
              )
            );
          }, timeoutMs);

          const check = () => {
            if (expectedPredicate(textA.toString(), textB.toString())) {
              cleanup();
              resolve();
            }
          };

          const cleanup = () => {
            clearTimeout(timeoutTimer);
            textA.unobserve(check);
            textB.unobserve(check);
          };

          textA.observe(check);
          textB.observe(check);
        });
      };

      for (let trial = 1; trial <= TOTAL_TRIALS; trial++) {
        const trialSeed = (rng() * 0xffffffff) >>> 0;
        const trialRng = createPrng(trialSeed);

        // 2. Reset document to known single-line content
        const knownSingleLine = `const count = ${trial}; // baseline line for trial ${trial}`;
        docA.transact(() => {
          const yText = docA.getText("code");
          yText.delete(0, yText.length);
          yText.insert(0, knownSingleLine);
        });

        // Ensure both providers reflect the baseline state before applying concurrent edits
        await waitForConvergence(
          (a, b) => a === knownSingleLine && b === knownSingleLine
        );

        // 3. Generate distinct insertion payloads for Participant A and Participant B
        const tokenA = Math.floor(trialRng() * 900000 + 100000).toString(36);
        const tokenB = Math.floor(trialRng() * 900000 + 100000).toString(36);
        const payloadA = `[A${trial}_${tokenA}]`;
        const payloadB = `[B${trial}_${tokenB}]`;

        // 4. Randomize insertion position on the same logical line
        const insertPosition = Math.floor(trialRng() * (knownSingleLine.length + 1));

        // 5 & 6. Concurrent execution & randomized operation interleaving
        // Both local edits are applied in the same synchronous turn before either
        // participant's WebSocket event queue processes the other's update.
        const aFirst = trialRng() < 0.5;
        if (aFirst) {
          docA.getText("code").insert(insertPosition, payloadA);
          docB.getText("code").insert(insertPosition, payloadB);
        } else {
          docB.getText("code").insert(insertPosition, payloadB);
          docA.getText("code").insert(insertPosition, payloadA);
        }

        // 7. Await Hocuspocus / Yjs bidirectional CRDT convergence
        const expectedTotalLength =
          knownSingleLine.length + payloadA.length + payloadB.length;
        await waitForConvergence(
          (a, b) =>
            a === b &&
            a.length === expectedTotalLength &&
            a.includes(payloadA) &&
            a.includes(payloadB)
        );

        // 8, 9 & 10. Verify convergence, no character loss, exact contents
        const finalA = docA.getText("code").toString();
        const finalB = docB.getText("code").toString();

        if (finalA !== finalB) {
          divergentCount++;
          throw new Error(
            `Trial ${trial} DIVERGED (seed: 0x${trialSeed.toString(16)}). DocA="${finalA}" != DocB="${finalB}"`
          );
        }

        const missingInA = !finalA.includes(payloadA) || !finalA.includes(payloadB);
        const missingInB = !finalB.includes(payloadA) || !finalB.includes(payloadB);
        if (missingInA || missingInB || finalA.length !== expectedTotalLength) {
          missingCharactersCount++;
          throw new Error(
            `Trial ${trial} LOST CHARACTERS (seed: 0x${trialSeed.toString(16)}). Expected length: ${expectedTotalLength}, actual: ${finalA.length}`
          );
        }

        convergedCount++;
      }

      console.log(`\n[ED-2 Convergence Benchmark]`);
      console.log(`Master Seed: 0x${MASTER_SEED.toString(16)}`);
      console.log(`Trials executed: ${TOTAL_TRIALS}`);
      console.log(`Converged: ${convergedCount}`);
      console.log(`Divergent: ${divergentCount}`);
      console.log(`Missing participant insertions: ${missingCharactersCount}`);

      expect(convergedCount).toBe(100);
      expect(divergentCount).toBe(0);
      expect(missingCharactersCount).toBe(0);
    } finally {
      providerA.destroy();
      providerB.destroy();
      wsA.destroy();
      wsB.destroy();
      docA.destroy();
      docB.destroy();
    }
  }, 60000); // 60s test budget for 100 trials
});
