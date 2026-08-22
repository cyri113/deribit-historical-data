/**
 * Structural exploration: Multi-expiry concurrency within a week.
 *
 * HYPOTHESIS: 20/23 weeks in v4's dataset have 2+ distinct expiries with
 * valid put liquidity in the 3-10 DTE band (max observed: 9 in one week).
 * v4 only ever picked ONE expiry per week (closest to 7 DTE) and ran one
 * ladder. If capital allows, running ladders on ALL qualifying expiries in
 * a week (not just the single closest-to-7-DTE one) should increase trade
 * frequency and capital utilization similarly to daily entry, but via a
 * different mechanism (expiry breadth instead of entry-date density).
 *
 * Mechanics: same margin sizing/utilization/delta targets as v4, but each
 * week, capital is split evenly across ALL qualifying expiries that week
 * (not just one), each getting its own 3-leg ladder sized to
 * available/n_expiries/3 per leg.
 *
 * Run with: bun analysis/exploration-multi-expiry.ts
 */
import { initializeDuckDB, executeSQLQuery, closeDuckDB } from "../src/infrastructure/duckdb-connection.ts";

const GOLD_PATH = "data/gold/BTC.parquet";
const INITIAL_CAPITAL = 100_000;
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

interface LadderResult {
  label: string; // week + expiry, since multiple per week now
  weekStartMs: number;
  expiryMs: number;
  capitalDeployedUsd: number;
  premiumCollectedUsd: number;
  assignmentLossUsd?: number;
  pnlUsd?: number;
}

function isoLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  await initializeDuckDB();

  // All qualifying (week, expiry) pairs -- not just the top-1-per-week.
  const weeklyExpiries = await executeSQLQuery<{
    wk_ms: bigint; wk_str: string; expiration_timestamp: string; n_valid: bigint;
  }>(`
    SELECT epoch_ms(date_trunc('week', timestamp)) as wk_ms,
      CAST(date_trunc('week', timestamp) AS VARCHAR) as wk_str,
      CAST(expiration_timestamp AS VARCHAR) as expiration_timestamp,
      COUNT(*) as n_valid
    FROM read_parquet('${GOLD_PATH}')
    WHERE is_valid = true AND option_type = 'put'
      AND days_to_expiry BETWEEN ${DTE_MIN} AND ${DTE_MAX}
    GROUP BY 1, 2, 3
    ORDER BY 1, 3
  `);

  // Group by week.
  const byWeek = new Map<number, { wk_str: string; expiries: string[] }>();
  for (const row of weeklyExpiries) {
    const wkMs = Number(row.wk_ms);
    if (!byWeek.has(wkMs)) byWeek.set(wkMs, { wk_str: row.wk_str, expiries: [] });
    byWeek.get(wkMs)!.expiries.push(row.expiration_timestamp);
  }

  console.log(`Weeks: ${byWeek.size}, total (week,expiry) pairs: ${weeklyExpiries.length}`);

  const results: LadderResult[] = [];
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
          r.pnlUsd = r.premiumCollectedUsd - assignmentLoss;
        }
        locks.splice(i, 1);
      }
    }
  }

  const sortedWeeks = [...byWeek.entries()].sort((a, b) => a[0] - b[0]);

  for (const [weekStartMs, { wk_str: wk, expiries }] of sortedWeeks) {
    releaseMaturedLocks(weekStartMs);

    const nExpiries = expiries.length;
    const budgetPerExpiry = available / nExpiries;

    for (const expIso of expiries) {
      if (available <= 1) break; // capital exhausted mid-week across expiries

      const legRows = await executeSQLQuery<{
        target_delta: number; strike: number; mark_price: number; delta: number;
        futures_price: number;
        outcome_settlement_price: number | null; outcome_assignment_inferred: boolean | null;
      }>(`
        WITH week_trades AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY instrument_name ORDER BY timestamp ASC) as rn_first
          FROM read_parquet('${GOLD_PATH}')
          WHERE is_valid = true AND option_type = 'put'
            AND expiration_timestamp = TIMESTAMP '${expIso}'
            AND date_trunc('week', timestamp) = TIMESTAMP '${wk}'
        ),
        first_trades AS (SELECT * FROM week_trades WHERE rn_first = 1),
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

      if (legRows.length < LADDER_TARGETS.length) continue; // skip this expiry, not the whole week

      // Use THIS expiry's budget share, but never more than currently available.
      const thisExpiryBudget = Math.min(budgetPerExpiry, available);
      const targetMarginPerLegUsd = thisExpiryBudget / LADDER_TARGETS.length;
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
      if (capitalDeployedUsd > available + 1e-6) continue;

      const premiumCollectedUsd = legs.reduce((s, l) => s + l.markPrice * l.amount * futuresPriceAtEntry, 0);
      available -= capitalDeployedUsd;
      available += premiumCollectedUsd;

      const expiryMs = new Date(expIso).getTime();
      const label = `${isoLabel(weekStartMs)}|${isoLabel(expiryMs)}`;
      locks.push({ label, notionalUsd: capitalDeployedUsd, releaseMs: expiryMs, legs });
      results.push({ label, weekStartMs, expiryMs, capitalDeployedUsd, premiumCollectedUsd });
    }
  }
  releaseMaturedLocks(Infinity);

  const totalPnl = results.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const firstMs = sortedWeeks[0]![0];
  const lastMs = sortedWeeks[sortedWeeks.length - 1]![0];
  const spanYears = (lastMs - firstMs) / (365.25 * 86400000);
  const apr = spanYears > 0 ? (totalPnl / INITIAL_CAPITAL) / spanYears : 0;

  const assigned = results.filter(r => (r.assignmentLossUsd ?? 0) > 0);
  const totalAssignLoss = assigned.reduce((s, r) => s + (r.assignmentLossUsd ?? 0), 0);
  const totalPremium = results.reduce((s, r) => s + r.premiumCollectedUsd, 0);

  console.log(`\nLadders entered: ${results.length} (across ${sortedWeeks.length} weeks)`);
  console.log(`Assignments: ${assigned.length}/${results.length} (${(assigned.length/results.length*100).toFixed(1)}%)`);
  console.log(`Total premium: $${totalPremium.toFixed(2)}, total assignment loss: $${totalAssignLoss.toFixed(2)}`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Span: ${spanYears.toFixed(2)} years`);
  console.log(`APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`\nBASELINE (v4, 1 expiry/week): 10.13% APR`);
  console.log(`MULTI-EXPIRY (all qualifying expiries/week): ${(apr * 100).toFixed(2)}%`);
  console.log(`Delta: ${((apr - 0.1013) * 100).toFixed(2)} pp`);

  await closeDuckDB();
}

main().catch(e => { console.error(e); process.exit(1); });
