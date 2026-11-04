import { createHmac } from "node:crypto";
import net from "node:net";
import mongoose from "mongoose";

export const SESSION_COOKIE_NAME = "pairprep.sid";

/**
 * Isolated configuration for end-to-end testing harness.
 * Uses a dedicated database (pairprep_e2e) and dedicated secret
 * to prevent contaminating test or development databases.
 */
export const E2E_CONFIG = {
  database: "pairprep_e2e",
  allowedHosts: ["127.0.0.1", "localhost"],
  mongoUri: process.env["E2E_MONGODB_URI"] || "mongodb://127.0.0.1:27017/pairprep_e2e",
  secret:
    process.env["E2E_SESSION_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test_e2e_secret_at_least_32_chars_long_for_security",
};

/**
 * Validates that the MongoDB URI adheres to the E2E host and name guards.
 * Prevents accidental connection to non-local or production/dev databases.
 */
export function validateE2EDatabaseUri(uri: string): {
  host: string;
  port: number;
  dbName: string;
} {
  const httpUrl = uri.replace(/^mongodb(\+srv)?:\/\//, "http://");
  const parsed = new URL(httpUrl);
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : 27017;
  const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];

  // Host guard: only local test hosts permitted for E2E
  if (!E2E_CONFIG.allowedHosts.includes(host)) {
    throw new Error(
      `E2E Database Host Guard Violation: Expected local host (${E2E_CONFIG.allowedHosts.join(
        ", "
      )}), got '${host}'`
    );
  }

  // Name guard: database must be strictly pairprep_e2e
  if (dbName !== E2E_CONFIG.database) {
    throw new Error(
      `E2E Database Name Guard Violation: Expected database '${E2E_CONFIG.database}', got '${dbName}'`
    );
  }

  return { host, port, dbName };
}

/**
 * Creates an HMAC-SHA256 signed express-session cookie string
 * matching the cookie-signature format used by express-session.
 */
export function signSessionId(sessionId: string, secret: string): string {
  const hash = createHmac("sha256", secret)
    .update(sessionId)
    .digest("base64")
    .replace(/=+$/, "");
  return `s:${sessionId}.${hash}`;
}

/**
 * Verifies and unsigns a signed cookie value.
 * Returns the original session ID if valid, or false if signature does not match.
 */
export function unsignSessionCookie(signedValue: string, secret: string): string | false {
  if (!signedValue.startsWith("s:")) return false;
  const raw = signedValue.slice(2);
  const dotIndex = raw.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const sessionId = raw.slice(0, dotIndex);
  const expectedHash = raw.slice(dotIndex + 1);

  const computedHash = createHmac("sha256", secret)
    .update(sessionId)
    .digest("base64")
    .replace(/=+$/, "");

  if (computedHash !== expectedHash) return false;
  return sessionId;
}

/**
 * Generates the complete Set-Cookie / Cookie header value
 * for an authenticated session.
 */
export function createSessionCookie(
  sessionId: string,
  secret: string = E2E_CONFIG.secret
): { name: string; value: string; header: string } {
  const signed = signSessionId(sessionId, secret);
  return {
    name: SESSION_COOKIE_NAME,
    value: signed,
    header: `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
  };
}

/**
 * Checks whether the E2E database port is accessible
 * without starting or probing system processes.
 */
export async function checkE2EDatabaseAvailable(timeoutMs = 800): Promise<boolean> {
  const { host, port } = validateE2EDatabaseUri(E2E_CONFIG.mongoUri);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      settled = true;
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.once("error", () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.connect(port, host);
  });
}

/**
 * Seeds a real user and authenticated session in MongoDB for E2E testing.
 */
export async function seedE2EUserAndSession(options?: {
  sessionId?: string;
  displayName?: string;
  email?: string;
}) {
  validateE2EDatabaseUri(E2E_CONFIG.mongoUri);

  const conn = await mongoose
    .createConnection(E2E_CONFIG.mongoUri, {
      serverSelectionTimeoutMS: 2000,
    })
    .asPromise();

  try {
    const userId = new mongoose.Types.ObjectId();
    const sessionId = options?.sessionId || `e2e_sess_${Date.now()}`;
    const displayName = options?.displayName || "Alice Host";
    const email = options?.email || "alice.e2e@example.com";

    // 1. Seed user in users collection
    await conn.collection("users").insertOne({
      _id: userId,
      provider: "github",
      providerId: `gh_${Date.now()}`,
      displayName,
      email,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 2. Seed session in sessions collection (connect-mongo format)
    await conn.collection("sessions").insertOne({
      _id: sessionId,
      session: JSON.stringify({
        cookie: {
          originalMaxAge: 604800000,
          expires: new Date(Date.now() + 604800000).toISOString(),
          secure: false,
          httpOnly: true,
          path: "/",
          sameSite: "lax",
        },
        passport: { user: userId.toString() },
      }),
      expires: new Date(Date.now() + 604800000),
    });

    const cookie = createSessionCookie(sessionId, E2E_CONFIG.secret);

    return {
      userId: userId.toString(),
      sessionId,
      cookie,
      cleanup: async () => {
        try {
          await conn.collection("sessions").deleteOne({ _id: sessionId });
          await conn.collection("users").deleteOne({ _id: userId });
          await conn.close();
        } catch {
          // ignore cleanup errors
        }
      },
    };
  } catch (err) {
    await conn.close();
    throw err;
  }
}
