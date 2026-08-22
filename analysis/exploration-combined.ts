/**
 * Structural exploration: Combined test of the two surviving levers.
 *
 * Idea 1 (daily entry, +10.91pp) and Idea 4 (early close on 25% profit
 * target, +14.51pp) both independently cleared the 0.5pp bar. Both are
 * capital-turnover mechanisms (daily entry increases entry frequency;
 * early close shortens each position's capital-lock duration) so they are
 * NOT assumed additive -- per the task's rule 4, testing explicitly.
 *
 * HYPOTHESIS: combining daily entry with early-close profit-taking should
 * compound (more entries AND each entry ties up capital for less time,
 * both increasing effective capital velocity) but the increment from
 * early-close specifically may shrink, since daily entries already hold
 * positions for a shorter average duration than weekly ones (positions are
 * naturally more numerous/smaller and expire sooner on average), leaving
 * less room for early-close to shorten hold time further.
 *
 * Mechanics: daily entry cadence (from exploration-daily-entry.ts) + first-
 * crossing profit-target early close at 25% of entry mark (from
 * exploration-early-close.ts, same look-ahead-safe logic), same margin
 * sizing/utilization/delta targets throughout.
 *
 * Run with: bun analysis/exploration-combined.ts
 */
import { initializeDuckDB, executeSQLQuery, closeDuckDB } from "../src/infrastructure/duckdb-connection.ts";

const GOLD_PATH = "data/gold/BTC.parquet";
const INITIAL_CAPITAL = 100_000;
const TARGET_DTE = 7;
const DTE_MIN = 3;
const DTE_MAX = 10;
const LADDER_TARGETS = [0.02, 0.05, 0.10];
const PROFIT_TARGET_PCT = 0.25;

interface Leg {
  instrument: string;
  strike: number;
  entryMarkPrice: number;
  amount: number;
  assigned: boolean | null;
  settlementPrice: number | null;
  marginUsd: number;
  entryPremiumUsd: number;
}

interface DayResultEntry {
  label: string; entered: boolean; skipReason?: string;
  capitalDeployedUsd?: number; premiumCollectedUsd?: number;
  assignmentLossUsd?: number; pnlUsd?: number; earlyClosed?: number;
  openLegsPremiumUsd?: number;
}

function isoLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  await initializeDuckDB();

  const dailyExpiryChoice = await executeSQLQuery<{
    day_ms: bigint; day_str: string; expiration_timestamp: string;
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

  console.log(`Candidate days: ${dailyExpiryChoice.length}`);

  const results: DayResultEntry[] = [];
  let available = INITIAL_CAPITAL;
  const locks: { label: string; notionalUsd: number; releaseMs: number; legs: Leg[] }[] = [];
  let totalEarlyCloses = 0;

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
          // pnlUsd was seeded at entry with early-closed-legs' net PnL only;
          // add the still-open (held-to-expiry) legs' premium minus their
          // assignment loss now that they've settled.
          r.pnlUsd = (r.pnlUsd ?? 0) + (r.openLegsPremiumUsd ?? 0) - assignmentLoss;
        }
        locks.splice(i, 1);
      }
    }
  }

  for (const { day_ms, day_str: dy, expiration_timestamp: expIso } of dailyExpiryChoice) {
    const startMs = Number(day_ms);
    const expiryMs = new Date(expIso).getTime();
    releaseMaturedLocks(startMs);
    const label = isoLabel(startMs);

    const legRows = await executeSQLQuery<{
      target_delta: number; strike: number; mark_price: number; delta: number;
      futures_price: number; instrument_name: string;
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
      SELECT target_delta, strike, mark_price, delta, futures_price, instrument_name,
        outcome_settlement_price, outcome_assignment_inferred
      FROM per_target WHERE rn_target = 1 ORDER BY target_delta
    `);

    if (legRows.length < LADDER_TARGETS.length) {
      results.push({ label, entered: false, skipReason: `only ${legRows.length}/3 legs` });
      continue;
    }
    if (available <= 1) {
      results.push({ label, entered: false, skipReason: `insufficient capital: ${available.toFixed(2)}` });
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
        instrument: r.instrument_name, strike: r.strike, entryMarkPrice: r.mark_price, amount,
        assigned: r.outcome_assignment_inferred, settlementPrice: r.outcome_settlement_price,
        marginUsd: marginPerContractUsd * amount,
        entryPremiumUsd: r.mark_price * amount * futuresPriceAtEntry,
      };
    });

    const capitalDeployedUsd = legs.reduce((s, l) => s + l.marginUsd, 0);
    const premiumCollectedUsd = legs.reduce((s, l) => s + l.entryPremiumUsd, 0);
    available -= capitalDeployedUsd;
    available += premiumCollectedUsd;

    let earlyClosedCount = 0;
    let earlyClosedPnl = 0;
    for (const leg of legs) {
      const crossing = await executeSQLQuery<{ mark_price: number }>(`
        SELECT mark_price
        FROM read_parquet('${GOLD_PATH}')
        WHERE is_valid = true AND instrument_name = '${leg.instrument}'
          AND timestamp < TIMESTAMP '${expIso}'
          AND mark_price <= ${leg.entryMarkPrice * PROFIT_TARGET_PCT}
        ORDER BY timestamp ASC LIMIT 1
      `);
      if (crossing.length === 0) continue;
      const buybackCostUsd = crossing[0]!.mark_price * leg.amount * futuresPriceAtEntry;
      const legPnl = leg.entryPremiumUsd - buybackCostUsd;
      available += leg.marginUsd - buybackCostUsd;
      (leg as any).__closedEarly = true;
      (leg as any).__closedPnl = legPnl;
      earlyClosedCount++;
      earlyClosedPnl += legPnl;
    }
    totalEarlyCloses += earlyClosedCount;

    const stillOpenLegs = legs.filter(l => !(l as any).__closedEarly);
    const remainingNotionalUsd = stillOpenLegs.reduce((s, l) => s + l.marginUsd, 0);
    const openLegsPremiumUsd = stillOpenLegs.reduce((s, l) => s + l.entryPremiumUsd, 0);

    locks.push({ label, notionalUsd: remainingNotionalUsd, releaseMs: expiryMs, legs: stillOpenLegs });
    results.push({ label, entered: true, capitalDeployedUsd, premiumCollectedUsd, earlyClosed: earlyClosedCount, pnlUsd: earlyClosedPnl, openLegsPremiumUsd });
  }
  releaseMaturedLocks(Infinity);

  const entered = results.filter(r => r.entered);
  const skipped = results.filter(r => !r.entered);
  const totalPnl = entered.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const firstMs = new Date(results[0]!.label).getTime();
  const lastMs = new Date(results[results.length - 1]!.label).getTime();
  const spanYears = (lastMs - firstMs) / (365.25 * 86400000);
  const apr = spanYears > 0 ? (totalPnl / INITIAL_CAPITAL) / spanYears : 0;

  const assigned = entered.filter(r => (r.assignmentLossUsd ?? 0) > 0);
  const totalAssignLoss = assigned.reduce((s, r) => s + (r.assignmentLossUsd ?? 0), 0);
  const totalPremium = entered.reduce((s, r) => s + (r.premiumCollectedUsd ?? 0), 0);
  const totalEarlyClosedLegs = entered.reduce((s, r) => s + (r.earlyClosed ?? 0), 0);

  console.log(`\nEntered: ${entered.length}, Skipped: ${skipped.length}`);
  console.log(`Legs closed early: ${totalEarlyClosedLegs}`);
  console.log(`Assignments: ${assigned.length}/${entered.length}`);
  console.log(`Total premium: $${totalPremium.toFixed(2)}, total assignment loss: $${totalAssignLoss.toFixed(2)}`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Span: ${spanYears.toFixed(2)} years`);
  console.log(`APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`\nBASELINE (v4): 10.13% APR`);
  console.log(`DAILY ENTRY ALONE: 21.04% APR (+10.91pp)`);
  console.log(`EARLY CLOSE ALONE: 24.64% APR (+14.51pp)`);
  console.log(`COMBINED (daily entry + early close): ${(apr * 100).toFixed(2)}%`);
  console.log(`Delta vs baseline: ${((apr - 0.1013) * 100).toFixed(2)}pp`);
  console.log(`Naive sum would predict: ${(10.13 + 10.91 + 14.51).toFixed(2)}%`);

  await closeDuckDB();
}

main().catch(e => { console.error(e); process.exit(1); });
