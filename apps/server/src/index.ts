import express, { Request, Response } from "express";
import cors from "cors";
import {
  PingResponse,
  PingResponseSchema,
  HealthResponse,
  HealthResponseSchema,
} from "@pairprep/shared";
import { requestLogger } from "./middleware/logger.js";

const app = express();
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3000;

app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Root endpoint for simple health/smoke check
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello from PairPrep Backend!");
});

// PRD 8.4 / OBS-4: Standardized Healthcheck endpoint
app.get("/healthz", (_req: Request, res: Response) => {
  const healthData: HealthResponse = {
    status: "ok",
    uptime: Math.round(process.uptime() * 100) / 100,
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  };

  const validated = HealthResponseSchema.parse(healthData);
  res.json(validated);
});

// Verified API endpoint utilizing @pairprep/shared Zod schema
app.get("/api/ping", (_req: Request, res: Response) => {
  const responseData: PingResponse = {
    status: "ok",
    message: "PairPrep backend & shared Zod schemas wired successfully",
    timestamp: new Date().toISOString(),
    environment:
      (process.env["NODE_ENV"] as PingResponse["environment"]) || "development",
  };

  // Runtime assertion with Zod to enforce schema contract
  const validated = PingResponseSchema.parse(responseData);
  res.json(validated);
});

if (process.env["NODE_ENV"] !== "test") {
  app.listen(PORT, () => {
    console.log(`[PairPrep Server] running on http://localhost:${PORT}`);
  });
}

export default app;
