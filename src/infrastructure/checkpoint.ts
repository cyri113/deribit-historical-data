import type { Database as BunDatabase } from "bun:sqlite";

export interface Checkpoint {
  id?: number;
  instrumentName: string;
  lastTradeSeq: number;
  lastTimestamp: number;
  chunkStartSeq?: number;
  chunkEndSeq?: number;
  status: "in_progress" | "completed" | "failed";
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Checkpoint manager for resumable downloads
 *
 * Tracks which chunks have been successfully downloaded for each instrument,
 * enabling resume from the last checkpoint after interruption.
 */
export class CheckpointManager {
  private db: BunDatabase;

  constructor(db: BunDatabase) {
    this.db = db;
  }

  /**
   * Save or update a checkpoint for an instrument chunk
   */
  saveCheckpoint(checkpoint: Checkpoint): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO checkpoints (
        instrument_name, last_trade_seq, last_timestamp,
        chunk_start_seq, chunk_end_seq, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      checkpoint.instrumentName,
      checkpoint.lastTradeSeq,
      checkpoint.lastTimestamp,
      checkpoint.chunkStartSeq ?? null,
      checkpoint.chunkEndSeq ?? null,
      checkpoint.status,
      Date.now()
    );
  }

  /**
   * Get the last checkpoint for an instrument
   */
  getLastCheckpoint(instrumentName: string): Checkpoint | null {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE instrument_name = ?
      ORDER BY last_trade_seq DESC
      LIMIT 1
    `);

    const row = stmt.get(instrumentName) as {
      id: number;
      instrument_name: string;
      last_trade_seq: number;
      last_timestamp: number;
      chunk_start_seq: number | null;
      chunk_end_seq: number | null;
      status: "in_progress" | "completed" | "failed";
      created_at: number;
      updated_at: number;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      instrumentName: row.instrument_name,
      lastTradeSeq: row.last_trade_seq,
      lastTimestamp: row.last_timestamp,
      chunkStartSeq: row.chunk_start_seq ?? undefined,
      chunkEndSeq: row.chunk_end_seq ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get all completed checkpoints for an instrument
   */
  getCompletedCheckpoints(instrumentName: string): Checkpoint[] {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE instrument_name = ? AND status = 'completed'
      ORDER BY chunk_start_seq ASC
    `);

    const rows = stmt.all(instrumentName) as Array<{
      id: number;
      instrument_name: string;
      last_trade_seq: number;
      last_timestamp: number;
      chunk_start_seq: number | null;
      chunk_end_seq: number | null;
      status: "in_progress" | "completed" | "failed";
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      instrumentName: row.instrument_name,
      lastTradeSeq: row.last_trade_seq,
      lastTimestamp: row.last_timestamp,
      chunkStartSeq: row.chunk_start_seq ?? undefined,
      chunkEndSeq: row.chunk_end_seq ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Check if a chunk is already completed
   */
  isChunkCompleted(
    instrumentName: string,
    chunkStartSeq?: number,
    chunkEndSeq?: number
  ): boolean {
    if (chunkStartSeq === undefined || chunkEndSeq === undefined) {
      return false;
    }

    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM checkpoints
      WHERE instrument_name = ?
        AND chunk_start_seq = ?
        AND chunk_end_seq = ?
        AND status = 'completed'
    `);

    const result = stmt.get(instrumentName, chunkStartSeq, chunkEndSeq) as {
      count: number;
    };

    return result.count > 0;
  }

  /**
   * Mark an instrument as fully completed
   */
  markInstrumentComplete(instrumentName: string, lastTradeSeq: number, lastTimestamp: number): void {
    this.saveCheckpoint({
      instrumentName,
      lastTradeSeq,
      lastTimestamp,
      status: "completed",
    });
  }

  /**
   * Get total number of completed chunks for an instrument
   */
  getCompletedChunkCount(instrumentName: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM checkpoints
      WHERE instrument_name = ? AND status = 'completed'
    `);

    const result = stmt.get(instrumentName) as { count: number };
    return result.count;
  }

  /**
   * Delete all checkpoints for an instrument (useful for resetting)
   */
  clearInstrumentCheckpoints(instrumentName: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM checkpoints WHERE instrument_name = ?
    `);
    stmt.run(instrumentName);
  }

  /**
   * Get statistics for all instruments
   */
  getCheckpointStats(): Array<{
    instrumentName: string;
    completedChunks: number;
    lastTradeSeq: number;
    status: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        instrument_name,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_chunks,
        MAX(last_trade_seq) as last_trade_seq,
        MAX(status) as status
      FROM checkpoints
      GROUP BY instrument_name
      ORDER BY instrument_name
    `);

    const rows = stmt.all() as Array<{
      instrument_name: string;
      completed_chunks: number;
      last_trade_seq: number;
      status: string;
    }>;

    return rows.map((row) => ({
      instrumentName: row.instrument_name,
      completedChunks: row.completed_chunks,
      lastTradeSeq: row.last_trade_seq,
      status: row.status,
    }));
  }
}
