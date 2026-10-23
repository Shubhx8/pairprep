import mongoose from "mongoose";
import "../../models/index.js";

export function getTestDbUri(suiteName: string): string {
  const baseUri = process.env["MONGODB_URI"] || "mongodb://127.0.0.1:27017/pairprep_test";

  // Replace default database name with isolated per-suite database name
  if (baseUri.includes("?")) {
    const [pathPart, queryPart] = baseUri.split("?");
    const basePath =
      pathPart?.replace(/\/pairprep[^/]*$/, "") || "mongodb://127.0.0.1:27017";
    return `${basePath}/pairprep_test_${suiteName}?${queryPart}`;
  }

  const basePath = baseUri.replace(/\/pairprep[^/]*$/, "");
  return `${basePath}/pairprep_test_${suiteName}`;
}

export async function setupTestDb(suiteName = "default"): Promise<void> {
  const uri = getTestDbUri(suiteName);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  // Ensure all registered model indexes are fully created and active
  for (const modelName of mongoose.modelNames()) {
    await mongoose.model(modelName).init();
    await mongoose.model(modelName).syncIndexes();
  }
}

export async function clearTestDb(): Promise<void> {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  }
}

export async function teardownTestDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    if (mongoose.connection.db) {
      // Clean up isolated test database
      await mongoose.connection.db.dropDatabase();
    }
    await mongoose.disconnect();
  }
}
