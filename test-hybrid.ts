import { DeribitClient } from "./src/infrastructure/deribit-client.ts";
import { Database } from "./src/infrastructure/database.ts";
import { JSONLStorage } from "./src/infrastructure/jsonl-storage.ts";
import { ParquetStorage } from "./src/infrastructure/parquet-storage.ts";
import { OptionFetcher } from "./src/application/fetchers/option-fetcher.ts";

// Test: Fetch a single option, verify JSONL → Parquet conversion
const client = new DeribitClient();
const database = new Database();
const jsonlStorage = new JSONLStorage("./data/test-jsonl");
const parquetStorage = new ParquetStorage({ baseDir: "./data/test-parquet" });

const testInstrument = "BTC-27DEC24-100000-C"; // A specific expired option

try {
  console.log("Testing hybrid JSONL → Parquet workflow...\n");
  
  // Check if JSONL file exists before
  const jsonlBefore = jsonlStorage.fileExists(testInstrument);
  console.log(`1. JSONL exists before: ${jsonlBefore}`);
  
  const fetcher = new OptionFetcher({
    client,
    database,
    jsonlStorage,
    parquetStorage,
    chunkSize: 10000,
    concurrency: 1,
  });
  
  console.log(`2. Fetching ${testInstrument}...`);
  const result = await fetcher.fetchInstrument(testInstrument);
  
  console.log(`3. Result: ${result.status}, ${result.totalTrades} trades`);
  
  // Check if JSONL was deleted and Parquet created
  const jsonlAfter = jsonlStorage.fileExists(testInstrument);
  const parquetPath = parquetStorage.getTradeFilePath(testInstrument);
  const fs = await import("node:fs");
  const parquetExists = fs.existsSync(parquetPath);
  
  console.log(`4. JSONL exists after: ${jsonlAfter} (should be false)`);
  console.log(`5. Parquet exists: ${parquetExists} (should be true)`);
  console.log(`6. Parquet path: ${parquetPath}`);
  
  if (!jsonlAfter && parquetExists) {
    console.log("\n✅ Hybrid workflow SUCCESS: JSONL deleted, Parquet created");
  } else {
    console.log("\n❌ Hybrid workflow FAILED");
  }
  
} catch (error) {
  console.error("Error:", error);
} finally {
  database.close();
  await jsonlStorage.closeAll();
}
