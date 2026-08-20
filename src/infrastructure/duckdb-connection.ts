import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/**
 * DuckDB Connection Manager using official @duckdb/node-api
 *
 * Provides access to DuckDB for:
 * - Memory-efficient Parquet processing
 * - Parallel Greeks computation via SQL
 * - Streaming large datasets without full memory load
 */

export interface DuckDBConfig {
  maxMemory?: string; // e.g., "4GB"
  threads?: number;
}

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;
let config: DuckDBConfig = {};

/**
 * Initialize DuckDB instance with configuration (singleton pattern)
 */
export async function initializeDuckDB(newConfig?: DuckDBConfig): Promise<void> {
  if (newConfig) {
    config = { ...config, ...newConfig };
  }

  if (!instance) {
    // Create in-memory instance with configuration
    const instanceConfig: Record<string, string> = {};

    if (config.maxMemory) {
      instanceConfig.memory_limit = config.maxMemory;
    }

    if (config.threads !== undefined) {
      instanceConfig.threads = String(config.threads);
    }

    instance = await DuckDBInstance.create(":memory:", instanceConfig);
  }
}

/**
 * Get or create a DuckDB connection
 */
export async function getDuckDBConnection(): Promise<DuckDBConnection> {
  if (!instance) {
    await initializeDuckDB();
  }

  if (!connection) {
    connection = await instance!.connect();
  }

  return connection;
}

/**
 * Execute a SQL query and return results as JSON
 */
export async function executeSQLQuery<T = any>(sql: string): Promise<T[]> {
  const conn = await getDuckDBConnection();
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRows();

  if (rows.length === 0) {
    return [];
  }

  // Convert array rows to objects using column names
  const columnNames = reader.columnNames();
  return rows.map(row => {
    const obj: any = {};
    columnNames.forEach((name, i) => {
      obj[name] = row[i];
    });
    return obj as T;
  });
}

/**
 * Execute a SQL statement without returning results (for DDL/DML)
 */
export async function executeSQLStatement(sql: string): Promise<void> {
  const conn = await getDuckDBConnection();
  await conn.run(sql);
}

/**
 * Close DuckDB connection and instance
 */
export async function closeDuckDB(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
  }

  if (instance) {
    await instance.close();
    instance = null;
  }
}
