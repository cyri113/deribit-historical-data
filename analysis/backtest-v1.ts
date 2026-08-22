/**
 * Baseline weekly put-ladder backtest (v1).
 *
 * Strategy: every week, if liquidity > 50th percentile, sell a 3-leg put
 * ladder (~2-delta, ~5-delta, ~10-delta) on the expiry closest to (but not
 * necessarily exactly) 7 days out. Hold to expiry (Deribit options are
 * European, cash-settled -- no early assignment is possible, so "hold 7
 * days or assignment" collapses to "hold to expiry, then check if it
 * settled ITM").
 *
 * DEVIATION FROM SPEC, DOCUMENTED: the task specifies a strict 7-day hold.
 * Verified against the full ~2-year dataset (both before and after a much
 * wider bronze fetch specifically aimed at finding more weekly cycles):
 * only 1 week in the entire dataset has ANY put trade with days_to_expiry
 * in [7,10], even before any liquidity/validity filtering. This is not a
 * data-coverage gap -- Deribit's BTC options volume is structurally
 * bimodal (0-3 DTE dominates; the 4-7 DTE tail is thin; almost nothing
 * lands specifically at 7-10 DTE) and independent research confirmed this
 * has been true since Deribit's Feb 2020 daily-expiry launch, not
 * something that improves by fetching further back in time. A strict
 * 7-day-hold backtest is therefore not runnable as a multi-week sample
 * against this market's real liquidity. DTE_MIN/DTE_MAX below widen the
 * acceptable window to [3,10] days (23 usable weeks vs. 1), with TARGET_DTE
 * still used to prefer whichever qualifying expiry is closest to the
 * originally-intended 7 days when more than one is available in a given
 * week. Actual DTE achieved is reported per week so this substitution's
 * real magnitude is visible, not hidden inside an "APR" number.
 *
 * Capital model ($100K initial):
 *   - At entry, the full cash-secured-put notional (sum of strike*amount
 *     across the 3 legs) is set aside from available capital and locked
 *     until THIS position's own expiry -- not released early even if a
 *     later week's entry point falls before it (verified against real data:
 *     positions genuinely overlap week boundaries here, since a ~7-10 day
 *     hold started on a Monday can expire after the following Monday).
 *   - Premium is collected immediately at entry (real option premium is
 *     paid upfront by the buyer), added to available (non-locked) capital
 *     right away.
 *   - At the position's expiry, the locked notional is released back to
 *     available capital, minus any assignment loss (which is realized then,
 *     not before -- the loss isn't known until settlement).
 *   - A week is skipped if the full 3-leg ladder can't be capitalized from
 *     currently-available (non-locked) capital.
 *
 * This is research/analysis code, not part of the production pipeline.
 * Run with: bun analysis/backtest-v1.ts
 */
import { initializeDuckDB, executeSQLQuery, closeDuckDB } from "../src/infrastructure/duckdb-connection.ts";

const GOLD_PATH = "data/gold/BTC.parquet";
const INITIAL_CAPITAL = 100_000; // USD
const TARGET_DTE = 7; // preferred DTE when multiple qualifying expiries exist in a week
const DTE_MIN = 3;
const DTE_MAX = 10; // acceptance band -- see file header for why this isn't just [7,10]
const LADDER_TARGETS = [0.02, 0.05, 0.10]; // target |delta| per leg
const HIT_RATE_THRESHOLD = 0.0038; // 0.38% premium/capital-deployed threshold

interface Leg {
  targetDelta: number;
  instrumentName: string;
  strike: number;
  markPrice: number; // BTC-denominated (Deribit inverse quote)
  delta: number;
  amount: number;
  assigned: boolean | null;
  settlementPrice: number | null;
}

interface WeekResult {
  weekLabel: string;
  weekStartMs: number;
  expiryMs: number;
  actualDte?: number; // days_to_expiry actually achieved this week (target was 7; see file header)
  entered: boolean;
  skipReason?: string;
  legs?: Leg[];
  futuresPriceAtEntry?: number;
  capitalDeployedUsd?: number;
  premiumCollectedUsd?: number;
  premiumPct?: number; // premiumCollectedUsd / capitalDeployedUsd -- the "collecting >0.38% premium" hit-rate metric, known at ENTRY, independent of assignment outcome
  assignmentLossUsd?: number; // realized at expiry, not at entry
  pnlUsd?: number; // premium - assignment loss, realized as of this position's expiry
  pnlPct?: number; // net pnl / capital deployed that week (realized at expiry, includes assignment loss)
  availableCapitalAtEntry?: number;
  availableCapitalAfterEntry?: number; // after this week's deployment+premium, before any releases
}

interface Lock {
  weekLabel: string;
  notionalUsd: number;
  releaseMs: number;
  legs: Leg[];
}

function isoWeekLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main() {
  await initializeDuckDB();

  // Step 1: for each ISO week, pick the expiry closest to the preferred
  // TARGET_DTE among expiries with actual put liquidity in [DTE_MIN,DTE_MAX].
  const weeklyExpiryChoice = await executeSQLQuery<{
    wk_ms: bigint;
    wk_str: string;
    expiration_timestamp: string;
    n_valid_puts: bigint;
    days_to_expiry: number;
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
    SELECT epoch_ms(wk) as wk_ms, CAST(wk AS VARCHAR) as wk_str, CAST(expiration_timestamp AS VARCHAR) as expiration_timestamp, n as n_valid_puts, days_to_expiry
    FROM ranked WHERE rn = 1 ORDER BY wk
  `);

  console.log(`Weeks with a usable [${DTE_MIN},${DTE_MAX}]-DTE expiry: ${weeklyExpiryChoice.length}`);

  // Step 2: liquidity distribution across all candidate weeks (50th
  // percentile gate). Proxy = summed trade_volume_7day across the chosen
  // expiry's valid put instruments that week.
  const liquidityByWeek = await executeSQLQuery<{ wk_ms: bigint; liquidity: number }>(`
    WITH weekly_expiry AS (
      SELECT date_trunc('week', timestamp) as wk, expiration_timestamp, days_to_expiry, COUNT(*) as n
      FROM read_parquet('${GOLD_PATH}')
      WHERE is_valid = true AND option_type = 'put'
        AND days_to_expiry BETWEEN ${DTE_MIN} AND ${DTE_MAX}
      GROUP BY 1, 2, 3
      QUALIFY ROW_NUMBER() OVER (PARTITION BY wk ORDER BY ABS(days_to_expiry - ${TARGET_DTE}), n DESC) = 1
    )
    SELECT epoch_ms(we.wk) as wk_ms, CAST(SUM(g.trade_volume_7day) AS DOUBLE) as liquidity
    FROM weekly_expiry we
    JOIN read_parquet('${GOLD_PATH}') g
      ON g.expiration_timestamp = we.expiration_timestamp
      AND date_trunc('week', g.timestamp) = we.wk
      AND g.is_valid = true AND g.option_type = 'put'
    GROUP BY 1 ORDER BY 1
  `);

  const liquidityValues = liquidityByWeek.map(r => r.liquidity).sort((a, b) => a - b);
  const p50Index = Math.floor(liquidityValues.length * 0.5);
  const liquidityP50 = liquidityValues[p50Index] ?? 0;
  console.log(`Liquidity 50th percentile (across ${liquidityValues.length} candidate weeks): ${liquidityP50.toFixed(0)}`);
  const liquidityMap = new Map(liquidityByWeek.map(r => [Number(r.wk_ms), r.liquidity]));

  // Step 3: sequential simulation.
  const results: WeekResult[] = [];
  let available = INITIAL_CAPITAL;
  const locks: Lock[] = [];

  let legsWithUnknownAssignment = 0;

  function releaseMaturedLocks(atMs: number) {
    for (let i = locks.length - 1; i >= 0; i--) {
      const lock = locks[i]!;
      if (lock.releaseMs <= atMs) {
        let assignmentLoss = 0;
        for (const l of lock.legs) {
          if (l.assigned === true) {
            assignmentLoss += l.settlementPrice !== null
              ? Math.max(l.strike - l.settlementPrice, 0) * l.amount
              : l.strike * l.amount; // defensive: assigned but no settlement price
          } else if (l.assigned === null) {
            // No real settlement/delivery data was available for this
            // expiry (Gold's outcome_assignment_inferred is NULL, not
            // fabricated) -- treated as "not assigned" for PnL purposes,
            // same as l.assigned === false. This is an optimistic
            // assumption (unknown outcomes are never counted as losses),
            // flagged in the final summary rather than silently absorbed.
            legsWithUnknownAssignment++;
          }
        }
        available += lock.notionalUsd - assignmentLoss;
        // Record the realized loss against the week that opened this lock.
        const openingWeek = results.find(r => r.weekLabel === lock.weekLabel);
        if (openingWeek) {
          openingWeek.assignmentLossUsd = assignmentLoss;
          openingWeek.pnlUsd = (openingWeek.premiumCollectedUsd ?? 0) - assignmentLoss;
          openingWeek.pnlPct = openingWeek.pnlUsd / (openingWeek.capitalDeployedUsd ?? 1);
        }
        locks.splice(i, 1);
      }
    }
  }

  for (const { wk_ms, wk_str: wk, expiration_timestamp: expIso, days_to_expiry: actualDte } of weeklyExpiryChoice) {
    const weekStartMs = Number(wk_ms);
    const expiryMs = new Date(expIso).getTime();

    releaseMaturedLocks(weekStartMs);

    const liquidity = liquidityMap.get(weekStartMs) ?? 0;
    if (liquidity <= liquidityP50) {
      results.push({
        weekLabel: isoWeekLabel(weekStartMs), weekStartMs, expiryMs, actualDte, entered: false,
        skipReason: `liquidity ${liquidity.toFixed(0)} <= P50 ${liquidityP50.toFixed(0)}`,
        availableCapitalAtEntry: available,
      });
      continue;
    }

    const legRows = await executeSQLQuery<{
      target_delta: number;
      instrument_name: string;
      strike: number;
      mark_price: number;
      delta: number;
      futures_price: number;
      outcome_settlement_price: number | null;
      outcome_assignment_inferred: boolean | null;
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
      SELECT target_delta, instrument_name, strike, mark_price, delta, futures_price,
        outcome_settlement_price, outcome_assignment_inferred
      FROM per_target WHERE rn_target = 1 ORDER BY target_delta
    `);

    if (legRows.length < LADDER_TARGETS.length) {
      results.push({
        weekLabel: isoWeekLabel(weekStartMs), weekStartMs, expiryMs, actualDte, entered: false,
        skipReason: `only ${legRows.length}/${LADDER_TARGETS.length} ladder legs available`,
        availableCapitalAtEntry: available,
      });
      continue;
    }

    // Size the ladder against a FIXED target notional (the full $100K
    // initial capital, split evenly across 3 legs), not against whatever
    // happens to be currently unlocked. Sizing against `available` directly
    // is circular (capitalDeployedUsd would always just equal available by
    // construction) and silently degrades into tiny scrap-capital
    // positions instead of skipping, defeating the task's explicit "skip
    // week if capital unavailable" rule -- confirmed as a real bug: it
    // produced $114-$268 "ladders" instead of skipping when most of the
    // $100K was still locked in a prior week's still-open position.
    const targetPerLegBudgetUsd = INITIAL_CAPITAL / LADDER_TARGETS.length;
    const futuresPriceAtEntry = legRows[0]!.futures_price;
    const legs: Leg[] = legRows.map(r => ({
      targetDelta: r.target_delta,
      instrumentName: r.instrument_name,
      strike: r.strike,
      markPrice: r.mark_price,
      delta: r.delta,
      amount: targetPerLegBudgetUsd / r.strike, // cash-secured sizing: strike*amount == target budget
      assigned: r.outcome_assignment_inferred,
      settlementPrice: r.outcome_settlement_price,
    }));

    const capitalDeployedUsd = legs.reduce((sum, l) => sum + l.strike * l.amount, 0);

    if (capitalDeployedUsd > available + 1e-6) {
      results.push({
        weekLabel: isoWeekLabel(weekStartMs), weekStartMs, expiryMs, actualDte, entered: false,
        skipReason: `insufficient capital: need ${capitalDeployedUsd.toFixed(0)}, have ${available.toFixed(0)}`,
        availableCapitalAtEntry: available,
      });
      continue;
    }

    const premiumCollectedUsd = legs.reduce((sum, l) => sum + l.markPrice * l.amount * futuresPriceAtEntry, 0);
    const availableCapitalAtEntry = available;

    // Deploy: lock the notional, collect premium immediately.
    available -= capitalDeployedUsd;
    available += premiumCollectedUsd;

    locks.push({
      weekLabel: isoWeekLabel(weekStartMs),
      notionalUsd: capitalDeployedUsd,
      releaseMs: expiryMs,
      legs,
    });

    results.push({
      weekLabel: isoWeekLabel(weekStartMs),
      weekStartMs,
      expiryMs,
      actualDte,
      entered: true,
      legs,
      futuresPriceAtEntry,
      capitalDeployedUsd,
      premiumCollectedUsd,
      premiumPct: premiumCollectedUsd / capitalDeployedUsd,
      // assignmentLossUsd / pnlUsd / pnlPct filled in by releaseMaturedLocks
      // once this position's expiry is reached in the simulation.
      availableCapitalAtEntry,
      availableCapitalAfterEntry: available,
    });
  }

  // Release any locks still open past the last simulated week (their
  // expiry has already passed relative to the data's own timeline).
  releaseMaturedLocks(Infinity);

  // Summary stats
  const entered = results.filter(r => r.entered);
  const skipped = results.filter(r => !r.entered);
  const totalPnl = entered.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
  // Hit rate per task spec: "% weeks collecting >0.38% premium" -- premium
  // collected relative to capital deployed, known at entry, independent of
  // whether the position was later assigned (that's net PnL, a separate
  // metric reported alongside).
  const hitWeeks = entered.filter(r => (r.premiumPct ?? -Infinity) > HIT_RATE_THRESHOLD);
  const hitRate = entered.length > 0 ? hitWeeks.length / entered.length : 0;

  const firstWeekMs = results[0]?.weekStartMs ?? 0;
  const lastWeekMs = results[results.length - 1]?.weekStartMs ?? 0;
  const spanYears = (lastWeekMs - firstWeekMs) / (365.25 * 24 * 60 * 60 * 1000);
  const finalCapital = INITIAL_CAPITAL + totalPnl;
  const totalReturn = totalPnl / INITIAL_CAPITAL;
  const apr = spanYears > 0 ? totalReturn / spanYears : 0;

  console.log(`\n=== Weekly Results ===`);
  for (const r of results) {
    if (r.entered) {
      console.log(
        `${r.weekLabel} | ENTERED (${r.actualDte}DTE) | deployed=$${r.capitalDeployedUsd!.toFixed(0)} | ` +
        `premium=$${r.premiumCollectedUsd!.toFixed(2)} (${((r.premiumPct ?? 0) * 100).toFixed(3)}%) | ` +
        `assignLoss=$${(r.assignmentLossUsd ?? 0).toFixed(2)} | ` +
        `pnl=$${(r.pnlUsd ?? 0).toFixed(2)} (${((r.pnlPct ?? 0) * 100).toFixed(3)}%) | ` +
        `legs assigned=[${r.legs!.map(l => l.assigned ? "Y" : "N").join(",")}]`
      );
    } else {
      console.log(`${r.weekLabel} | SKIPPED (${r.actualDte}DTE) | ${r.skipReason}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total candidate weeks: ${results.length}`);
  console.log(`Entered: ${entered.length}, Skipped: ${skipped.length}`);
  const skipReasonCounts = new Map<string, number>();
  for (const r of skipped) {
    const key = r.skipReason!.split(":")[0]!;
    skipReasonCounts.set(key, (skipReasonCounts.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of skipReasonCounts) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Final capital: $${finalCapital.toFixed(2)} (from $${INITIAL_CAPITAL})`);
  console.log(`Backtest span: ${spanYears.toFixed(2)} years (${firstWeekMs ? isoWeekLabel(firstWeekMs) : "?"} to ${lastWeekMs ? isoWeekLabel(lastWeekMs) : "?"})`);
  console.log(`Total return: ${(totalReturn * 100).toFixed(2)}%`);
  console.log(`Annualized APR: ${(apr * 100).toFixed(2)}%`);
  console.log(`Hit rate (weeks >${(HIT_RATE_THRESHOLD * 100).toFixed(2)}% premium, entered weeks only): ${(hitRate * 100).toFixed(1)}% (${hitWeeks.length}/${entered.length})`);
  if (legsWithUnknownAssignment > 0) {
    console.log(`\n⚠️  ${legsWithUnknownAssignment} leg(s) had no real settlement/delivery data available -- treated as NOT assigned (optimistic assumption). See docs/data-model.md's outcome_settlement_price caveat.`);
  }

  await closeDuckDB();
  return { results, apr, hitRate, totalPnl, entered: entered.length, skipped: skipped.length, legsWithUnknownAssignment };
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
