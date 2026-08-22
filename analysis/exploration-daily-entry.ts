/**
 * Structural exploration: Daily entry cadence instead of weekly.
 *
 * HYPOTHESIS: v1-v4 all entered once per calendar week (23 weeks total).
 * The data actually has 3-10 DTE put liquidity on 135 distinct DAYS, not
 * just 23 weeks. If the strategy enters daily instead of weekly (still
 * holding each position to its own expiry, still one ladder per entry),
 * trade frequency roughly 5.9x's and -- if per-trade economics hold up at
 * daily cadence -- APR should scale up substantially, since v4's dominant
 * lever was shown to be capital efficiency/utilization, and daily entry is
 * a direct expansion of capital-utilization opportunity, not a new
 * mechanism.
 *
 * This reuses v4's exact mechanics (margin sizing, full-capital
 * utilization, no liquidity filter, 2/5/10-delta) -- only the entry
 * cadence changes from date_trunc('week', ...) to date_trunc('day', ...).
 *
 * Run with: bun analysis/exploration-daily-entry.ts
 */
import { initializeDuckDB, executeSQLQuery, closeDuckDB } from "../src/infrastructure/duckdb-connection.ts";

const GOLD_PATH = "data/gold/BTC.parquet";
const INITIAL_CAPITAL = 100_000;
const TARGET_DTE = 7;
const DTE_MIN = 3;
const DTE_MAX = 10;
const LADDER_TARGETS = [0.02, 0.05, 0.10];

interface Leg {
  strike: number;
  markPrice: number;
  amount: number;
  assigned: boolean | null;
  settlementPrice: number | null;
  marginUsd: number;
}

interface EntryResult {
  label: string;
  startMs: number;
  expiryMs: number;
  entered: boolean;
  skipReason?: string;
  capitalDeployedUsd?: number;
  premiumCollectedUsd?: number;
  assignmentLossUsd?: number;
  pnlUsd?: number;
}

function isoLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  await initializeDuckDB();

  const dailyExpiryChoice = await executeSQLQuery<{
    day_ms: bigint;
    day_str: string;
    expiration_timestamp: string;
  }>(`
    WITH daily AS (
      SELECT date_trunc('day', timestamp) as dy, expiration_timestamp, days_to_expiry, COUNT(*) as n
      FROM read_parquet('${GOLD_PATH}')
      WHERE is_valid = true AND option_type = 'put'
        AND days_to_expiry BETWEEN ${DTE_MIN} AND ${DTE_MAX}
      GROUP BY 1, 2, 3
    ),
    ranked AS (
      SELECT dy, expiration_timestamp, n, days_to_expiry,
        ROW_NUMBER() OVER (PARTITION BY dy ORDER BY ABS(days_to_expiry - ${TARGET_DTE}), n DESC) as rn
      FROM daily
    )
    SELECT epoch_ms(dy) as day_ms, CAST(dy AS VARCHAR) as day_str, CAST(expiration_timestamp AS VARCHAR) as expiration_timestamp
    FROM ranked WHERE rn = 1 ORDER BY dy
  `);

  console.log(`Candidate days: ${dailyExpiryChoice.length} (vs. v4's 23 weeks)`);

  const results: EntryResult[] = [];
  let available = INITIAL_CAPITAL;
  const locks: { label: string; notionalUsd: number; releaseMs: number; legs: Leg[] }[] = [];

  function releaseMaturedLocks(atMs: number) {
    for (let i = locks.length - 1; i >= 0; i--) {
      const lock = locks[i]!;
      if (lock.releaseMs <= atMs) {
        let assignmentLoss = 0;
        for (const l of lock.legs) {
          if (l.assigned === true) {
            assignmentLoss += l.settlementPrice !== null
              ? Math.max(l.strike - l.settlementPrice, 0) * l.amount
              : l.strike * l.amount;
          }
        }
        available += lock.notionalUsd - assignmentLoss;
        const r = results.find(r => r.label === lock.label);
        if (r) {
          r.assignmentLossUsd = assignmentLoss;
          r.pnlUsd = (r.premiumCollectedUsd ?? 0) - assignmentLoss;
        }
        locks.splice(i, 1);
      }
    }
  }

  for (const { day_ms, day_str: dy, expiration_timestamp: expIso } of dailyExpiryChoice) {
    const startMs = Number(day_ms);
    const expiryMs = new Date(expIso).getTime();
    releaseMaturedLocks(startMs);

    const legRows = await executeSQLQuery<{
      target_delta: number; strike: number; mark_price: number; delta: number;
      futures_price: number;
      outcome_settlement_price: number | null; outcome_assignment_inferred: boolean | null;
    }>(`
      WITH day_trades AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY instrument_name ORDER BY timestamp ASC) as rn_first
        FROM read_parquet('${GOLD_PATH}')
        WHERE is_valid = true AND option_type = 'put'
          AND expiration_timestamp = TIMESTAMP '${expIso}'
          AND date_trunc('day', timestamp) = TIMESTAMP '${dy}'
      ),
      first_trades AS (SELECT * FROM day_trades WHERE rn_first = 1),
      per_target AS (
        SELECT t.*, target.d as target_delta,
          ROW_NUMBER() OVER (PARTITION BY target.d ORDER BY ABS(ABS(t.delta) - target.d)) as rn_target
        FROM first_trades t
        CROSS JOIN (SELECT UNNEST(${JSON.stringify(LADDER_TARGETS)}::DOUBLE[]) as d) target
      )
      SELECT target_delta, strike, mark_price, delta, futures_price,
        outcome_settlement_price, outcome_assignment_inferred
      FROM per_target WHERE rn_target = 1 ORDER BY target_delta
    `);

    if (legRows.length < LADDER_TARGETS.length) {
      results.push({ label: isoLabel(startMs), startMs, expiryMs, entered: false, skipReason: `only ${legRows.length}/3 legs` });
      continue;
    }
    if (available <= 1) {
      results.push({ label: isoLabel(startMs), startMs, expiryMs, entered: false, skipReason: `insufficient capital: ${available.toFixed(2)}` });
      continue;
    }

    const targetMarginPerLegUsd = available / LADDER_TARGETS.length;
    const futuresPriceAtEntry = legRows[0]!.futures_price;
    const legs: Leg[] = legRows.map(r => {
      const otmPct = Math.max((futuresPriceAtEntry - r.strike) / futuresPriceAtEntry, 0);
      const marginRate = Math.max(0.15 - otmPct, 0.10);
      const marginPerContractUsd = (marginRate + r.mark_price) * futuresPriceAtEntry;
      const amount = targetMarginPerLegUsd / marginPerContractUsd;
      return {
        strike: r.strike, markPrice: r.mark_price, amount,
        assigned: r.outcome_assignment_inferred, settlementPrice: r.outcome_settlement_price,
        marginUsd: marginPerContractUsd * amount,
      };
    });

    const capitalDeployedUsd = legs.reduce((s, l) => s + l.marginUsd, 0);
    const premiumCollectedUsd = legs.reduce((s, l) => s + l.markPrice * l.amount * futuresPriceAtEntry, 0);
    available -= capitalDeployedUsd;
    available += premiumCollectedUsd;
    locks.push({ label: isoLabel(startMs), notionalUsd: capitalDeployedUsd, releaseMs: expiryMs, legs });

    results.push({
      label: isoLabel(startMs), startMs, expiryMs, entered: true,
      capitalDeployedUsd, premiumCollectedUsd,
    });
  }
  releaseMaturedLocks(Infinity);

  const entered = results.filter(r => r.entered);
  const skipped = results.filter(r => !r.entered);
  const totalPnl = entered.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const firstMs = results[0]?.startMs ?? 0;
  const lastMs = results[results.length - 1]?.startMs ?? 0;
  const spanYears = (lastMs - firstMs) / (365.25 * 86400000);
  const apr = spanYears > 0 ? (totalPnl / INITIAL_CAPITAL) / spanYears : 0;

  console.log(`\nEntered: ${entered.length}, Skipped: ${skipped.length}`);
  const skipReasons = new Map<string, number>();
  for (const r of skipped) {
    const key = r.skipReason!.split(":")[0]!;
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
  }
  for (const [k, v] of skipReasons) console.log(`  ${k}: ${v}`);

  const assigned = entered.filter(r => (r.assignmentLossUsd ?? 0) > 0);
  const totalAssignLoss = assigned.reduce((s, r) => s + (r.assignmentLossUsd ?? 0), 0);
  const totalPremium = entered.reduce((s, r) => s + (r.premiumCollectedUsd ?? 0), 0);
  console.log(`\nAssignments: ${assigned.length}/${entered.length} entries (${(assigned.length/entered.length*100).toFixed(1)}%) -- v4 baseline was 1/23 (4.3%)`);
  console.log(`Total premium collected: $${totalPremium.toFixed(2)}`);
  console.log(`Total assignment loss: $${totalAssignLoss.toFixed(2)} (${(totalAssignLoss/totalPremium*100).toFixed(2)}% of premium)`);

  console.log(`\nTotal PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Span: ${spanYears.toFixed(2)} years`);
  console.log(`APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`\nBASELINE (v4, weekly): 10.13% APR`);
  console.log(`DAILY ENTRY: ${(apr * 100).toFixed(2)}% APR`);
  console.log(`Delta: ${((apr - 0.1013) * 100).toFixed(2)} pp`);

  await closeDuckDB();
}

main().catch(e => { console.error(e); process.exit(1); });
