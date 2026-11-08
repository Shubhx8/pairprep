import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { setupTestDb, teardownTestDb, getTestDbUri } from "./testDb.js";
import {
  verifyRequiredDatabaseIndexes,
  disconnectDatabase,
} from "../../db/connection.js";
import { DocUpdateModel } from "../../models/doc_updates.js";
import { bootstrapServer } from "../../index.js";

describe("Startup Index Readiness Verification (Commit 5e Task A)", () => {
  beforeEach(async () => {
    await setupTestDb("startup_index_readiness");
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it("fails verification if MongoDB is not connected", async () => {
    await disconnectDatabase();
    expect(mongoose.connection.readyState).toBe(0);

    await expect(verifyRequiredDatabaseIndexes()).rejects.toThrow(
      /Cannot verify database indexes: MongoDB is not connected/
    );
  });

  it("succeeds verification when required unique compound index is present", async () => {
    expect(mongoose.connection.readyState).toBe(1);
    await expect(verifyRequiredDatabaseIndexes()).resolves.toBeUndefined();
  });

  it("fails fast with descriptive error if required index is missing", async () => {
    // Drop the unique compound index
    try {
      await DocUpdateModel.collection.dropIndex("roomId_1_seq_1");
    } catch {
      // Index might have different name or already dropped
    }

    await expect(verifyRequiredDatabaseIndexes()).rejects.toThrow(
      "Database readiness check failed: missing required unique compound index { roomId: 1, seq: 1 } on doc_updates"
    );
  });

  it("fails fast if { roomId: 1, seq: 1 } exists but is not marked unique", async () => {
    // Drop existing unique index
    try {
      await DocUpdateModel.collection.dropIndex("roomId_1_seq_1");
    } catch {
      // Ignore
    }

    // Create non-unique compound index
    await DocUpdateModel.collection.createIndex(
      { roomId: 1, seq: 1 },
      { name: "roomId_1_seq_1_nonunique", unique: false }
    );

    await expect(verifyRequiredDatabaseIndexes()).rejects.toThrow(
      /Database readiness check failed: index \{ roomId: 1, seq: 1 \} on doc_updates is not unique/
    );
  });

  it("preserves unrelated or DBA-created indexes (non-destructive check)", async () => {
    // Create an unrelated index simulating DBA operational tuning
    await DocUpdateModel.collection.createIndex(
      { custom_operational_tag: 1 },
      { name: "dba_operational_idx" }
    );

    // Run verification - must NOT drop or alter unrelated indexes
    await verifyRequiredDatabaseIndexes();

    const indexes = await DocUpdateModel.collection.listIndexes().toArray();
    const dbaIndex = indexes.find((idx) => idx.name === "dba_operational_idx");
    expect(dbaIndex).toBeDefined();
    expect(dbaIndex?.key).toEqual({ custom_operational_tag: 1 });
  });

  it("executes full 10-step bootstrapServer lifecycle and shuts down cleanly", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined) as unknown as (
          code?: string | number | null | undefined
        ) => never
      );

    const testUri = getTestDbUri("startup_bootstrap");
    const result = await bootstrapServer(0, testUri);

    expect(result.server).toBeDefined();
    expect(result.syncServer).toBeDefined();
    expect(typeof result.handleShutdown).toBe("function");

    // Clean graceful shutdown
    await result.handleShutdown("SIGTERM");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  }, 15000);

  it("fails fast on bootstrapServer if MongoDB is unreachable", async () => {
    await disconnectDatabase();
    const unreachableUri = "mongodb://127.0.0.1:54321/pairprep_unreachable";
    await expect(
      bootstrapServer(0, unreachableUri, {
        maxRetries: 1,
        initialDelayMs: 50,
        maxDelayMs: 100,
      })
    ).rejects.toThrow();
  }, 10000);
});
