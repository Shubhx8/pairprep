import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Server } from "node:http";
import { config } from "./config.js";
import { requestLogger, rootLogger } from "./middleware/logger.js";
import { sessionMiddleware } from "./middleware/auth.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { validateContentType } from "./middleware/contentType.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFoundHandler.js";
import { roomsRouter } from "./routes/rooms.js";
import {
  PingResponse,
  PingResponseSchema,
  HealthResponse,
  HealthResponseSchema,
} from "@pairprep/shared";

const app = express();
const PORT = config.PORT;

// Trust proxy set to 1 for reverse proxy (Caddy on Azure VM per AD-1)
app.set("trust proxy", 1);

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

// CORS allowlist
app.use(
  cors({
    origin: config.NODE_ENV === "production" ? config.SITE_ORIGIN : true,
    credentials: true,
  })
);

// Content-Type validation and strict 100 KB JSON payload size limit
app.use(validateContentType);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Structured JSON request logging & X-Request-Id tagging
app.use(requestLogger);

// Authentication & guest session handling
app.use(sessionMiddleware);

// Mount Room API under /api/v1/rooms (PRD 13.1)
app.use("/api/v1/rooms", roomsRouter);

// Root smoke test endpoint
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello from PairPrep Backend!");
});

// PRD 8.4 / 13.1 / OBS-4: Healthcheck endpoint returning { status, uptimeSec, version }
app.get("/healthz", (_req: Request, res: Response) => {
  const uptimeSec = Math.round(process.uptime() * 100) / 100;
  const healthData: HealthResponse = {
    status: "ok",
    uptimeSec,
    version: config.GIT_SHA || "0.1.0",
  };

  const validated = HealthResponseSchema.parse(healthData);
  res.json(validated);
});

// Smoke ping endpoint
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
): { handleShutdown: (signal: string) => void } {
  let isShuttingDown = false;

  const handleShutdown = (signal: string) => {
    if (isShuttingDown) {
      rootLogger.warn(
        { signal },
        "Shutdown already in progress. Ignoring duplicate signal."
      );
      return;
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

    // Stop accepting new connections while letting active requests finish
    server.close(async () => {
      clearInterval(idleInterval);
      try {
        if (onShutdown) {
          await onShutdown();
        }
        rootLogger.info("All in-flight requests completed. Exiting cleanly.");
        process.exit(0);
      } catch (err) {
        rootLogger.error({ err }, "Error during cleanup shutdown tasks");
        process.exit(1);
      }
    });

    // Force close after 10 seconds max if requests are hanging
    const timeout = setTimeout(() => {
      rootLogger.error("Shutdown timed out after 10s. Forcing exit.");
      process.exit(1);
    }, 10000);
    timeout.unref();
  };

  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  process.once("SIGINT", () => handleShutdown("SIGINT"));

  return { handleShutdown };
}

let server: Server | undefined;

if (process.env["NODE_ENV"] !== "test") {
  server = app.listen(PORT, () => {
    rootLogger.info(
      { port: PORT, env: config.NODE_ENV },
      `[PairPrep Server] running on http://localhost:${PORT}`
    );
  });
  setupGracefulShutdown(server);
}

export { server };
export default app;
