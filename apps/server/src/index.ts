import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Server, createServer } from "node:http";
import { config } from "./config.js";
import { getTrustProxyFn } from "./config/proxyTrust.js";
import { requestLogger, rootLogger } from "./middleware/logger.js";
import { createSessionMiddleware } from "./middleware/session.js";
import passport from "passport";
import "./auth/passport.js";
import { csrfProtection } from "./middleware/csrf.js";
import { authRateLimiter } from "./middleware/authRateLimiter.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { validateContentType } from "./middleware/contentType.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFoundHandler.js";
import { identify } from "./middleware/identity.js";
import { startArchiveJob, stopArchiveJob } from "./services/archiveJob.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { attachSyncServer, SyncServerInstance } from "./sync/hocuspocus.js";
import { roomsRouter } from "./routes/rooms.js";
import {
  getDatabaseStatus,
  connectDatabase,
  disconnectDatabase,
  verifyRequiredDatabaseIndexes,
} from "./db/connection.js";
import {
  PingResponse,
  PingResponseSchema,
  HealthResponse,
  HealthResponseSchema,
} from "@pairprep/shared";

const app = express();
const PORT = config.PORT;

// Trust proxy compiled using centralized reverse proxy configuration (Caddy on Azure VM per AD-1)
app.set("trust proxy", getTrustProxyFn());

// Structured JSON request logging & X-Request-Id tagging mounted FIRST
// Ensures all requests (including rate-limited, rejected CORS, and oversized bodies) are tagged and logged
app.use(requestLogger);

// Security headers with Helmet: CSP set to report-only mode for Monaco editor compatibility
app.use(
  helmet({
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  })
);

// Global IP-based rate limiting (100 requests per minute per IP, configurable)
app.use(apiRateLimiter);

// CORS allowlist strictly allowing configured dev origins or production site origin
const allowedOrigins =
  config.NODE_ENV === "production"
    ? [config.SITE_ORIGIN]
    : [
        config.SITE_ORIGIN,
        config.CLIENT_ORIGIN,
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
      ].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like curl, server-to-server, or same-origin)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

// Content-Type validation and strict 100 KB JSON payload size limit with inflate: false
app.use(validateContentType);
app.use(express.json({ limit: "100kb", inflate: false }));
app.use(cookieParser());

// PRD 8.4 / 13.1 / OBS-4 & T03: Stateless healthcheck endpoint returning { status, uptimeSec, version, db }
// Placed BEFORE sessionMiddleware and rate limiters so health probes never set cookies or create sessions
app.get("/healthz", (_req: Request, res: Response) => {
  const uptimeSec = Math.round(process.uptime() * 100) / 100;
  const healthData: HealthResponse = {
    status: "ok",
    uptimeSec,
    version: config.GIT_SHA || "0.1.0",
    db: getDatabaseStatus(),
  };

  const validated = HealthResponseSchema.parse(healthData);
  res.json(validated);
});

// Stateless smoke ping endpoint
app.get("/api/ping", (_req: Request, res: Response) => {
  const responseData: PingResponse = {
    status: "ok",
    message: "PairPrep backend & shared Zod schemas wired successfully",
    timestamp: new Date().toISOString(),
    environment:
      (process.env["NODE_ENV"] as PingResponse["environment"]) || "development",
  };

  const validated = PingResponseSchema.parse(responseData);
  res.json(validated);
});

// PRD 6.1 / T04 Exact Middleware Chain:
// 1. authRateLimiter mounted on /api/v1/auth BEFORE sessionMiddleware to prevent database session spam
app.use("/api/v1/auth", authRateLimiter);

// 2. sessionMiddleware mounted strictly on /api routes
app.use("/api", createSessionMiddleware());

// 3. passport.initialize()
app.use("/api", passport.initialize());

// 4. passport.session()
app.use("/api", passport.session());

// Identity middleware: populates req.principal, req.userId, and req.isGuest
app.use("/api", identify);

// 5. csrfProtection (rejects untrusted state-changing requests with 403 CSRF_REJECTED)
app.use("/api", csrfProtection);

// 6. authRouter
app.use("/api/v1/auth", authRouter);

// 7. meRouter
app.use("/api/v1/me", meRouter);

// 8. roomsRouter (fine-grained authorization handled per route within router)
app.use("/api/v1/rooms", roomsRouter);

// Root smoke test endpoint
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello from PairPrep Backend!");
});

// Central 404 handler for unknown routes
app.use(notFoundHandler);

// Central error handler enforcing standard { error: { code, message, requestId } } format
app.use(errorHandler);

/**
 * Attaches graceful shutdown signal listeners to an HTTP server instance.
 * Closes idle keep-alive connections, drains in-flight requests (up to 10s),
 * guards against duplicate signal invocations, and exits code 0.
 */
export function setupGracefulShutdown(
  server: Server,
  onShutdown?: () => Promise<void> | void
): { handleShutdown: (signal: string) => Promise<void> } {
  let isShuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const handleShutdown = (signal: string): Promise<void> => {
    if (isShuttingDown) {
      rootLogger.warn(
        { signal },
        "Shutdown already in progress. Ignoring duplicate signal."
      );
      return shutdownPromise ?? Promise.resolve();
    }
    isShuttingDown = true;

    rootLogger.info(
      { signal },
      "Graceful shutdown signal received. Stopping new connections..."
    );

    // Close idle keep-alive connections immediately (Node 19+)
    const closeIdle = () => {
      if (
        typeof (server as unknown as { closeIdleConnections?: () => void })
          .closeIdleConnections === "function"
      ) {
        (
          server as unknown as { closeIdleConnections: () => void }
        ).closeIdleConnections();
      }
    };

    closeIdle();
    const idleInterval = setInterval(closeIdle, 25);
    idleInterval.unref();

    stopArchiveJob();

    shutdownPromise = (async () => {
      // 1. Initiate onShutdown (sync server drain & persistence flush) concurrently
      // with server.close() so active WebSockets close and do not deadlock server.close()
      const syncShutdownPromise = onShutdown
        ? Promise.resolve(onShutdown())
        : Promise.resolve();

      // 2. Initiate HTTP server closure to stop accepting new HTTP requests
      const serverClosePromise = new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Force close after 10 seconds max if requests or flush are hanging
      const timeout = setTimeout(() => {
        rootLogger.error("Shutdown timed out after 10s. Forcing exit.");
        process.exit(1);
      }, 10000);
      timeout.unref();

      try {
        await Promise.all([syncShutdownPromise, serverClosePromise]);
        clearTimeout(timeout);
        clearInterval(idleInterval);

        // 3. Disconnect MongoDB only after all sync persistence writes and in-flight HTTP requests complete
        await disconnectDatabase();
        rootLogger.info(
          "All in-flight requests and sync updates completed. Exiting cleanly."
        );
        process.exit(0);
      } catch (err) {
        clearTimeout(timeout);
        clearInterval(idleInterval);
        rootLogger.error({ err }, "Error during cleanup shutdown tasks");
        process.exit(1);
      }
    })();

    return shutdownPromise;
  };

  process.once("SIGTERM", () => {
    void handleShutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void handleShutdown("SIGINT");
  });

  return { handleShutdown };
}

export interface BootstrapResult {
  server: Server;
  syncServer: SyncServerInstance;
  handleShutdown: (signal: string) => Promise<void>;
}

/**
 * Executes the authoritative 10-step server bootstrap lifecycle:
 * 1. Initialize configuration (loaded via config.js)
 * 2. Connect to MongoDB
 * 3. Initialize/provision required database indexes (via Mongoose model init)
 * 4. Verify physical MongoDB indexes directly via driver catalog
 * 5. Initialize application jobs requiring database (startArchiveJob)
 * 6. Construct HTTP server without listening
 * 7. Attach sync server and WebSocket upgrade handler
 * 8. Register graceful shutdown handlers
 * 9. Start listening for HTTP traffic
 * 10. Report application readiness
 * Fails fast with descriptive error if database connection or index verification fails.
 */
export async function bootstrapServer(
  port = PORT,
  mongoUri = config.MONGODB_URI,
  dbOptions?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  }
): Promise<BootstrapResult> {
  // 1. Initialize configuration (already loaded via config import)

  // 2. Connect to MongoDB
  if (mongoUri) {
    await connectDatabase(mongoUri, dbOptions);

    // 3 & 4. Initialize and physically verify required MongoDB indexes
    await verifyRequiredDatabaseIndexes();

    // 5. Initialize application jobs that require the database
    startArchiveJob();
  }

  // 6. Construct the HTTP server without listening
  const httpServer = createServer(app);

  // 7. Attach the sync server and upgrade handler
  const syncServer = attachSyncServer(httpServer);

  // 8. Register graceful shutdown handlers
  const { handleShutdown } = setupGracefulShutdown(httpServer, async () => {
    await syncServer.drainAndShutdown();
  });

  // 9. Start listening for HTTP traffic
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => resolve());
    httpServer.once("error", reject);
  });

  // 10. Report application readiness
  rootLogger.info(
    { port, env: config.NODE_ENV },
    `[PairPrep Server] running on http://localhost:${port}`
  );

  return { server: httpServer, syncServer, handleShutdown };
}

let server: Server | undefined;

if (process.env["NODE_ENV"] !== "test") {
  bootstrapServer().then(
    (res) => {
      server = res.server;
    },
    (err) => {
      rootLogger.fatal(
        { err },
        "Fatal error during server bootstrap; terminating process"
      );
      process.exit(1);
    }
  );
}

export { server };
export default app;
