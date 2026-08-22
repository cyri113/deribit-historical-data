/**
 * Structural exploration: Call-side ladder (mirror of the put strategy).
 *
 * HYPOTHESIS: Calls have near-identical coverage to puts in Gold
 * (115,996 valid call rows vs 115,324 valid puts; same 23 weeks qualify in
 * the 3-10 DTE band). v4 only ever sold puts. A short call ladder
 * (2/5/10-delta calls, same margin/utilization mechanics) tests whether
 * the edge is put-specific (e.g. a volatility risk premium asymmetry
 * between calls and puts, common in crypto due to persistent downside
 * skew) or whether calls capture similar economics.
 *
 * Run with: bun analysis/exploration-calls.ts
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

async function main() {
  await initializeDuckDB();

  const weeklyExpiryChoice = await executeSQLQuery<{
    wk_ms: bigint; wk_str: string; expiration_timestamp: string;
  }>(`
    WITH weekly AS (
      SELECT date_trunc('week', timestamp) as wk, expiration_timestamp, days_to_expiry, COUNT(*) as n
      FROM read_parquet('${GOLD_PATH}')
      WHERE is_valid = true AND option_type = 'call'
        AND days_to_expiry BETWEEN ${DTE_MIN} AND ${DTE_MAX}
      GROUP BY 1, 2, 3
    ),
    ranked AS (
      SELECT wk, expiration_timestamp, n, days_to_expiry,
        ROW_NUMBER() OVER (PARTITION BY wk ORDER BY ABS(days_to_expiry - ${TARGET_DTE}), n DESC) as rn
      FROM weekly
    )
    SELECT epoch_ms(wk) as wk_ms, CAST(wk AS VARCHAR) as wk_str, CAST(expiration_timestamp AS VARCHAR) as expiration_timestamp
    FROM ranked WHERE rn = 1 ORDER BY wk
  `);

  console.log(`Candidate weeks (calls, 3-10 DTE): ${weeklyExpiryChoice.length}`);

  const results: { label: string; capitalDeployedUsd: number; premiumCollectedUsd: number; assignmentLossUsd?: number; pnlUsd?: number }[] = [];
  let available = INITIAL_CAPITAL;
  const locks: { label: string; notionalUsd: number; releaseMs: number; legs: Leg[] }[] = [];

  function releaseMaturedLocks(atMs: number) {
    for (let i = locks.length - 1; i >= 0; i--) {
      const lock = locks[i]!;
      if (lock.releaseMs <= atMs) {
        let assignmentLoss = 0;
        for (const l of lock.legs) {
          if (l.assigned === true) {
            // For a short CALL, assignment loss = (settlement - strike) *
            // amount if settlement > strike (the call finished ITM and the
            // seller must deliver above-strike value).
            assignmentLoss += l.settlementPrice !== null
              ? Math.max(l.settlementPrice - l.strike, 0) * l.amount
              : l.strike * l.amount; // defensive fallback
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

  for (const { wk_ms, wk_str: wk, expiration_timestamp: expIso } of weeklyExpiryChoice) {
    const weekStartMs = Number(wk_ms);
    const expiryMs = new Date(expIso).getTime();
    releaseMaturedLocks(weekStartMs);

    const legRows = await executeSQLQuery<{
      target_delta: number; strike: number; mark_price: number; delta: number;
      futures_price: number;
      outcome_settlement_price: number | null; outcome_assignment_inferred: boolean | null;
    }>(`
      WITH week_trades AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY instrument_name ORDER BY timestamp ASC) as rn_first
        FROM read_parquet('${GOLD_PATH}')
        WHERE is_valid = true AND option_type = 'call'
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

    if (legRows.length < LADDER_TARGETS.length || available <= 1) continue;

    const targetMarginPerLegUsd = available / LADDER_TARGETS.length;
    const futuresPriceAtEntry = legRows[0]!.futures_price;
    const legs: Leg[] = legRows.map(r => {
      // Margin for a short call: OTM% = (strike - underlying) / underlying
      // (mirror of the put formula -- a call is OTM when strike > underlying).
      const otmPct = Math.max((r.strike - futuresPriceAtEntry) / futuresPriceAtEntry, 0);
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

    const label = new Date(weekStartMs).toISOString().slice(0, 10);
    locks.push({ label, notionalUsd: capitalDeployedUsd, releaseMs: expiryMs, legs });
    results.push({ label, capitalDeployedUsd, premiumCollectedUsd });
  }
  releaseMaturedLocks(Infinity);

  const totalPnl = results.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const firstMs = new Date(results[0]!.label).getTime();
  const lastMs = new Date(results[results.length - 1]!.label).getTime();
  const spanYears = (lastMs - firstMs) / (365.25 * 86400000);
  const apr = spanYears > 0 ? (totalPnl / INITIAL_CAPITAL) / spanYears : 0;

  const assigned = results.filter(r => (r.assignmentLossUsd ?? 0) > 0);
  const totalAssignLoss = assigned.reduce((s, r) => s + (r.assignmentLossUsd ?? 0), 0);
  const totalPremium = results.reduce((s, r) => s + r.premiumCollectedUsd, 0);

  console.log(`\nWeeks entered: ${results.length}`);
  console.log(`Assignments: ${assigned.length}/${results.length}`);
  console.log(`Total premium: $${totalPremium.toFixed(2)}, total assignment loss: $${totalAssignLoss.toFixed(2)}`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Span: ${spanYears.toFixed(2)} years`);
  console.log(`APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`\nBASELINE (v4, puts): 10.13% APR`);
  console.log(`CALL LADDER: ${(apr * 100).toFixed(2)}%`);
  console.log(`Delta: ${((apr - 0.1013) * 100).toFixed(2)} pp`);

  await closeDuckDB();
}

main().catch(e => { console.error(e); process.exit(1); });
