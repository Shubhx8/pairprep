import { describe, it, expect, afterEach } from "vitest";
import mongoose from "mongoose";
import {
  connectDatabase,
  disconnectDatabase,
  getDatabaseStatus,
  sanitizeMongoUri,
} from "../../db/connection.js";

describe("Database Connection (T03)", () => {
  afterEach(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  it("sanitizeMongoUri: redacts credentials from mongodb URI", () => {
    const raw =
      "mongodb+srv://user:secret123@cluster0.abc.mongodb.net/pairprep_dev?retryWrites=true";
    const sanitized = sanitizeMongoUri(raw);
    expect(sanitized).toBe(
      "mongodb+srv://***:***@cluster0.abc.mongodb.net/pairprep_dev?retryWrites=true"
    );
    expect(sanitized).not.toContain("secret123");
    expect(sanitized).not.toContain("user:");
  });

  it("connection: cleanly disconnects without hung sockets on graceful shutdown", async () => {
    const uri = process.env["MONGODB_URI"] || "mongodb://127.0.0.1:27017/pairprep_test";
    await connectDatabase(uri, { maxRetries: 2, initialDelayMs: 100 });
    expect(getDatabaseStatus()).toBe("ok");

    await disconnectDatabase();
    expect(getDatabaseStatus()).toBe("down");
    expect(mongoose.connection.readyState).toBe(0);
  });

  it("connection: retries and throws after max attempts when host is unreachable", async () => {
    // Unreachable local port
    const unreachableUri = "mongodb://127.0.0.1:54321/pairprep_invalid";
    await expect(
      connectDatabase(unreachableUri, {
        maxRetries: 2,
        initialDelayMs: 50,
        maxDelayMs: 100,
      })
    ).rejects.toThrow(/Failed to connect to MongoDB after 2 attempts/);
  }, 15000);
});
