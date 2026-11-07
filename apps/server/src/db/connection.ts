import mongoose from "mongoose";
import { rootLogger } from "../middleware/logger.js";
import { DocUpdateModel } from "../models/doc_updates.js";
import { DocSnapshotModel } from "../models/doc_snapshots.js";

interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

let isConnecting = false;

/**
 * Strips credentials from a MongoDB connection URI for safe logging.
 * Replaces username:password with ***:***.
 */
export function sanitizeMongoUri(uri: string): string {
  try {
    return uri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@");
  } catch {
    return "[REDACTED_URI]";
  }
}

/**
 * Returns the current database health state.
 * Mongoose readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
 */
export function getDatabaseStatus(): "ok" | "down" {
  return mongoose.connection.readyState === 1 ? "ok" : "down";
}

/**
 * Connects to MongoDB with exponential backoff retry and a 5000ms serverSelectionTimeoutMS.
 * Never logs credentials.
 */
export async function connectDatabase(
  uri: string,
  options: RetryOptions = {}
): Promise<typeof mongoose> {
  const maxRetries = options.maxRetries ?? 5;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;

  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (isConnecting) {
    // Wait for in-progress connection attempt
    return new Promise((resolve, reject) => {
      mongoose.connection.once("connected", () => resolve(mongoose));
      mongoose.connection.once("error", (err) => reject(err));
    });
  }

  isConnecting = true;
  const safeUri = sanitizeMongoUri(uri);
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      rootLogger.info(
        { target: safeUri, attempt, maxRetries },
        "Connecting to MongoDB..."
      );

      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
      });

      rootLogger.info({ target: safeUri }, "MongoDB connected successfully.");
      isConnecting = false;
      return mongoose;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      rootLogger.warn(
        { attempt, maxRetries, error: errorMessage },
        "MongoDB connection attempt failed."
      );

      if (attempt >= maxRetries) {
        isConnecting = false;
        throw new Error(
          `Failed to connect to MongoDB after ${maxRetries} attempts: ${errorMessage}`
        );
      }

      const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  isConnecting = false;
  throw new Error(`Failed to connect to MongoDB after ${maxRetries} attempts.`);
}

/**
 * Disconnects cleanly from MongoDB on server shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    rootLogger.info("Closing MongoDB connection...");
    await mongoose.disconnect();
    rootLogger.info("MongoDB disconnected cleanly.");
  }
}

/**
 * Verifies that the required physical unique compound index on doc_updates exists
 * and matches the exact specification { roomId: 1, seq: 1 } with unique === true.
 * Non-destructive: awaits model index building and directly inspects native driver indexes,
 * never dropping unrelated external or DBA-created indexes.
 */
export async function verifyRequiredDatabaseIndexes(): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    throw new Error(
      `Cannot verify database indexes: MongoDB is not connected (readyState: ${mongoose.connection.readyState})`
    );
  }

  // 1. Await model index initialization (creates declared schema indexes if not already built)
  await DocUpdateModel.init();
  await DocSnapshotModel.init();

  // 2. Query MongoDB's physical index catalog directly via the collection driver
  const indexes = await DocUpdateModel.collection.listIndexes().toArray();

  // 3. Locate the index matching key pattern { roomId: 1, seq: 1 }
  const matchingIndex = indexes.find((idx) => {
    const keys = Object.keys(idx.key || {});
    return (
      keys.length === 2 &&
      idx.key.roomId === 1 &&
      idx.key.seq === 1
    );
  });

  if (!matchingIndex) {
    throw new Error(
      "Database readiness check failed: missing required unique compound index { roomId: 1, seq: 1 } on doc_updates"
    );
  }

  if (matchingIndex.unique !== true) {
    throw new Error(
      `Database readiness check failed: index { roomId: 1, seq: 1 } on doc_updates is not unique (found: unique=${matchingIndex.unique})`
    );
  }

  rootLogger.info(
    { index: matchingIndex.name },
    "Verified required unique compound index on doc_updates successfully."
  );
}
