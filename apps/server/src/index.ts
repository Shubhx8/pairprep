import express, { Request, Response } from "express";
import cors from "cors";
import { PingResponse, PingResponseSchema } from "@pairprep/shared";

const app = express();
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3000;

app.use(cors());
app.use(express.json());

// Root endpoint for simple health/smoke check
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello from PairPrep Backend!");
});

// Verified API endpoint utilizing @pairprep/shared Zod schema
app.get("/api/ping", (_req: Request, res: Response) => {
  const responseData: PingResponse = {
    status: "ok",
    message: "PairPrep backend & shared Zod schemas wired successfully",
    timestamp: new Date().toISOString(),
    environment: (process.env["NODE_ENV"] as PingResponse["environment"]) || "development",
  };

  // Runtime assertion with Zod to enforce schema contract
  const validated = PingResponseSchema.parse(responseData);
  res.json(validated);
});

app.listen(PORT, () => {
  console.log(`[PairPrep Server] running on http://localhost:${PORT}`);
});

export default app;
