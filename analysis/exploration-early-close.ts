/**
 * Structural exploration: Early close (rolling) instead of hold-to-expiry.
 *
 * HYPOTHESIS: v1-v4 always hold every leg to expiry/settlement, taking
 * assignment risk for the full life of the position. Real path data exists
 * within each week (3-5 distinct trading days, hundreds of trades on the
 * SAME instrument per expiry -- verified via survey). If a leg's mark price
 * decays to a small fraction of the entry premium before expiry (i.e. most
 * of the profit is already captured and remaining premium is thin), closing
 * it early -- buying back at the later mark price -- releases capital
 * sooner (compounding faster, similar mechanism to daily entry) AND cuts
 * off the tail risk that caused v4's one assignment. This tests a profit-
 * target close: if a leg's LATEST observed mark price before expiry has
 * decayed to <= 25% of its entry mark price, close it there instead of
 * holding to settlement.
 *
 * Mechanics: same margin sizing/utilization/delta targets/weekly cadence as
 * v4. Per entered week, look up each leg's last trade price on its own
 * instrument before expiry within the data. If that later price <= 25% of
 * entry mark, "close" the leg then (capital + captured PnL released at that
 * timestamp instead of at expiry) -- this ALSO means capital compounds
 * faster for the next week's entry, so this partially isolates the
 * early-close lever from the daily-entry lever (still weekly entry cadence,
 * only the CLOSE timing changes).
 *
 * Run with: bun analysis/exploration-early-close.ts
 */
import { initializeDuckDB, executeSQLQuery, closeDuckDB } from "../src/infrastructure/duckdb-connection.ts";

const GOLD_PATH = "data/gold/BTC.parquet";
const INITIAL_CAPITAL = 100_000;
const TARGET_DTE = 7;
const DTE_MIN = 3;
const DTE_MAX = 10;
const LADDER_TARGETS = [0.02, 0.05, 0.10];
const PROFIT_TARGET_PCT = 0.25; // close if mark decays to <=25% of entry mark

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

function isoLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  await initializeDuckDB();

  const weeklyExpiryChoice = await executeSQLQuery<{
    wk_ms: bigint; wk_str: string; expiration_timestamp: string;
  }>(`
    WITH weekly AS (
      SELECT date_trunc('week', timestamp) as wk, expiration_timestamp, days_to_expiry, COUNT(*) as n
      FROM read_parquet('${GOLD_PATH}')
      WHERE is_valid = true AND option_type = 'put'
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

  console.log(`Candidate weeks: ${weeklyExpiryChoice.length}`);

  const results: { label: string; capitalDeployedUsd: number; premiumCollectedUsd: number; assignmentLossUsd?: number; pnlUsd?: number; earlyClosed?: number }[] = [];
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
      futures_price: number; instrument_name: string;
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
      SELECT target_delta, strike, mark_price, delta, futures_price, instrument_name,
        outcome_settlement_price, outcome_assignment_inferred
      FROM per_target WHERE rn_target = 1 ORDER BY target_delta
    `);

    if (legRows.length < LADDER_TARGETS.length || available <= 1) continue;

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

    const label = isoLabel(weekStartMs);

    // Check each leg's LAST observed mark price on its own instrument before
    // expiry, within this week's trading data, for a profit-target close.
    let earlyClosedCount = 0;
    for (const leg of legs) {
      // First moment (chronologically, after entry) the mark price crosses
      // the profit-target threshold -- this is what a trader monitoring the
      // position could actually have acted on in real time, unlike picking
      // the single latest pre-expiry data point with hindsight.
      const crossing = await executeSQLQuery<{ mark_price: number; ts_ms: bigint }>(`
        SELECT mark_price, epoch_ms(timestamp) as ts_ms
        FROM read_parquet('${GOLD_PATH}')
        WHERE is_valid = true AND instrument_name = '${leg.instrument}'
          AND timestamp < TIMESTAMP '${expIso}'
          AND mark_price <= ${leg.entryMarkPrice * PROFIT_TARGET_PCT}
        ORDER BY timestamp ASC LIMIT 1
      `);
      if (crossing.length === 0) continue;
      const later = crossing[0]!;
      if (later.mark_price <= leg.entryMarkPrice * PROFIT_TARGET_PCT) {
        // Close early: buy back at later mark price. Realized PnL for this
        // leg = entry premium collected - buyback cost. No assignment risk
        // from this point forward for this leg.
        const buybackCostUsd = later.mark_price * leg.amount * futuresPriceAtEntry;
        const legPnl = leg.entryPremiumUsd - buybackCostUsd;
        // Remove this leg's margin+premium contribution from the pending
        // lock; release its margin capital immediately, credit the realized
        // PnL immediately (already collected premium; give back buyback cost;
        // release margin).
        available += leg.marginUsd - buybackCostUsd;
        // Zero out the leg's future assignment exposure and remove its
        // notional from the week's lock so releaseMaturedLocks won't
        // double count it: mark as already-settled and remove from legs list.
        (leg as any).__closedEarly = true;
        (leg as any).__closedPnl = legPnl;
        earlyClosedCount++;
      }
    }
    totalEarlyCloses += earlyClosedCount;

    const stillOpenLegs = legs.filter(l => !(l as any).__closedEarly);
    const closedLegsPnl = legs.filter(l => (l as any).__closedEarly).reduce((s, l) => s + (l as any).__closedPnl, 0);
    // Reduce the week's locked notional by the margin already released for closed legs.
    const remainingNotionalUsd = stillOpenLegs.reduce((s, l) => s + l.marginUsd, 0);

    locks.push({ label, notionalUsd: remainingNotionalUsd, releaseMs: expiryMs, legs: stillOpenLegs });
    results.push({ label, capitalDeployedUsd, premiumCollectedUsd, earlyClosed: earlyClosedCount });
    // Track early-closed PnL by folding it into premiumCollectedUsd's
    // eventual pnlUsd accounting: adjust at release time via a side-channel.
    (results[results.length - 1] as any).__earlyClosedPnl = closedLegsPnl;
  }
  releaseMaturedLocks(Infinity);

  // Fold early-closed-leg PnL into each week's final pnlUsd.
  for (const r of results) {
    const extra = (r as any).__earlyClosedPnl ?? 0;
    r.pnlUsd = (r.pnlUsd ?? 0) + extra;
  }

  const totalPnl = results.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  const firstMs = new Date(results[0]!.label).getTime();
  const lastMs = new Date(results[results.length - 1]!.label).getTime();
  const spanYears = (lastMs - firstMs) / (365.25 * 86400000);
  const apr = spanYears > 0 ? (totalPnl / INITIAL_CAPITAL) / spanYears : 0;

  const assigned = results.filter(r => (r.assignmentLossUsd ?? 0) > 0);
  const totalAssignLoss = assigned.reduce((s, r) => s + (r.assignmentLossUsd ?? 0), 0);
  const totalPremium = results.reduce((s, r) => s + r.premiumCollectedUsd, 0);

  console.log(`\nWeeks entered: ${results.length}`);
  console.log(`Legs closed early (profit-target <=${PROFIT_TARGET_PCT * 100}% of entry mark): ${totalEarlyCloses}`);
  console.log(`Assignments (remaining held-to-expiry legs): ${assigned.length}/${results.length}`);
  console.log(`Total premium: $${totalPremium.toFixed(2)}, total assignment loss: $${totalAssignLoss.toFixed(2)}`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Span: ${spanYears.toFixed(2)} years`);
  console.log(`APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`\nBASELINE (v4, hold-to-expiry): 10.13% APR`);
  console.log(`EARLY CLOSE (25% profit target): ${(apr * 100).toFixed(2)}%`);
  console.log(`Delta: ${((apr - 0.1013) * 100).toFixed(2)} pp`);

  await closeDuckDB();
}

main().catch(e => { console.error(e); process.exit(1); });
