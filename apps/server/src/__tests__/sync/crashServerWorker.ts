import { createServer } from "node:http";
import mongoose from "mongoose";
import { attachSyncServer, createSyncServer } from "../../sync/hocuspocus.js";

const mongoUri =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/pairprep_test";
const port = parseInt(process.env.PORT || "0", 10);

await mongoose.connect(mongoUri);

const httpServer = createServer();
attachSyncServer(
  httpServer,
  createSyncServer({ requireAuth: false })
);

httpServer.listen(port, () => {
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  console.log(`READY:${actualPort}`);
});
