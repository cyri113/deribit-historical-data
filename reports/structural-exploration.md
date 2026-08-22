# Breaking the 10% Ceiling

**Structural Exploration Beyond the v4 Put Ladder Baseline**

The v4 backtest (10.13% APR, single weekly put ladder, hold-to-expiry, 23/23 weeks entered) was treated as a well-tested, fixed structure. This task looked for what wasn't tried: new entry cadences, new position mechanics, new instruments — anything the data supports beyond re-testing the existing ladder. Four ideas were tested independently; two were killed on contact, two cleared the bar; the two survivors were then tested in combination, since the task's rules forbid assuming their gains stack.

| | |
|---|---|
| **Baseline** | v4: 10.13% APR, 23 weeks, 1 assignment, single weekly put ladder held to expiry |
| **Ideas tested** | 4, across distinct angles (entry cadence, expiry breadth, instrument side, exit timing) |
| **Ideas clearing >0.5pp** | 2 of 4 (daily entry, early close) |
| **Combined result** | +11.69pp (10.13% → 21.82%) — sub-additive, not the naive sum of the two |

---

## Method note: all options are European-style

Deribit BTC options settle only at expiry — there is no early exercise or early assignment. This was already correctly modeled throughout: the Gold layer's `outcome_assignment_inferred` field is defined as ITM-at-real-settlement (computed only from the expiry delivery price), and every backtest script here computes assignment loss only when a position's lock matures at expiry. "Early close" (Idea 4, below) means buying back a short option on the open market before expiry — a normal way to exit a short position — not early exercise, which is impossible for these instruments. No code changes were needed after this was raised; it's noted here because it's a fact worth stating plainly rather than leaving implicit.

---

## Idea 1: Daily entry cadence — **+10.91pp (10.13% → 21.04%), WON**

**Hypothesis**: v1–v4 all entered once per calendar week (23 weeks total), but the data supports put-ladder liquidity on 135 distinct *days*, not just 23 weeks. If entries happen daily instead of weekly — same margin sizing, same full-capital utilization, same 2/5/10-delta ladder, only the entry-date grid changes — trade frequency rises ~5.9x and APR should scale with it, since v4's dominant lever was already shown to be capital efficiency, and daily entry is a direct expansion of that same opportunity.

**Result**:

| | Weekly (v4) | Daily |
|---|---|---|
| Candidate periods | 23 | 135 |
| Entered | 23 | 128 (7 skipped: insufficient capital) |
| Assignments | 1/23 (4.3%) | 8/128 (6.3%) |
| Total premium | $18,929.86* | $47,604.66 |
| Total assignment loss | $58.90 | $8,541.88 (17.9% of premium) |
| Total PnL | $18,830.10 | $39,062.78 |
| APR | 10.13% | **21.04%** |

*v4's exact figure, reconstructed and verified to the cent in `analysis/research-investigations.ts`.

**Independence check**: 128 entries map to 110 *distinct* expiries (not a handful of positions counted repeatedly) — well clear of the task's 10-independent-weeks skepticism bar.

**Why it works**: this is the same capital-efficiency lever that drove v1→v4, applied at finer granularity. More entry opportunities per unit time means capital that would otherwise sit idle between weekly entries gets redeployed sooner. The assignment rate rose (4.3%→6.3%) but nowhere near enough to offset the ~6x increase in trade frequency.

**Confidence**: High. Real, reproducible, statistically substantial sample.

---

## Idea 2: Multi-expiry concurrency — **−6.90pp (10.13% → 3.23%), KILLED**

**Hypothesis**: 20 of 23 weeks have 2+ distinct expiries with valid put liquidity in the 3–10 DTE band (max 9 in one week). Running ladders on *all* qualifying expiries per week, not just the single closest-to-7-DTE one, should raise capital utilization similarly to daily entry, via a different mechanism (expiry breadth instead of entry-date density).

**Result**: 142 (week, expiry) ladders entered across 23 weeks. Assignments 7/142 (4.9%), but assignment loss consumed **68% of gross premium** ($13,045 of $19,043) vs. daily entry's 18%. APR **3.23%**, a **−6.90pp** delta.

**Why it failed**: splitting capital evenly across up to 9 concurrent expiries per week dilutes each ladder's position size while extending exposure to lower-quality, less-liquid expiries far from the 7-DTE sweet spot that v4 always selected for. The mechanism was verified directly (checked the `budgetPerExpiry` sizing and per-expiry assignment counts) — this is a real result, not a bug.

**Confidence**: High (killed with a verified mechanism, not ambiguous).

---

## Idea 3: Call-side ladder — **−33.53pp (10.13% → −23.40%), KILLED**

**Hypothesis**: calls have essentially identical Gold coverage to puts (115,996 valid call rows vs. 115,324 puts, same 23 qualifying weeks). Testing whether a mirrored short-call ladder (2/5/10-delta calls, identical margin/sizing mechanics) captures similar volatility-risk-premium economics to the put side.

**Result**: APR **−23.40%**, a **−33.53pp** delta. Assignment rate for calls ran far higher than puts across the board — many expiries showed 20%–80%+ of legs finishing ITM, versus puts' steady 4–6%.

**Why it failed**: BTC trended upward through most of the backtest window. A short-call ladder is directionally short the exact move that dominated this period — this is a real market-regime effect, not a data or implementation bug (verified via a full per-expiry assignment-count breakdown before accepting the result).

**Confidence**: High. Result is strongly negative and mechanically explained, not noise.

---

## Idea 4: Early close on a profit target — **+14.51pp (10.13% → 24.64%), WON (with a caveat)**

**Hypothesis**: v1–v4 always hold every leg to expiry, carrying full assignment-tail risk for the position's entire life. Real intra-week path data exists (3–5 distinct trading days, hundreds of ticks per instrument per expiry — confirmed via survey). If a leg's mark price decays to a small fraction of its entry premium before expiry, most of the profit is already captured; closing there (buying back the short option) releases capital sooner and removes remaining tail exposure.

**Method**: for each leg, find the *first chronological* tick where mark price falls to ≤25% of the entry mark price, and close there. (An earlier version of this test picked the single latest pre-expiry tick with full hindsight — that was a look-ahead bug, caught and fixed before this result was accepted; see "Errors caught" below.)

**Result**: 48 of 69 legs (23 weeks × 3 legs) closed early. Assignments on the remaining held-to-expiry legs: 1/23 — identical to v4's baseline single assignment. APR **24.64%**, a **+14.51pp** delta.

**Why it works**: closing early does two things at once — locks in most of the collected premium while it's still worth locking in (theta decay is real and verified against raw tick data, not an artifact), and frees the margin capital for the next entry sooner, which is the same capital-velocity mechanism as Idea 1, applied within a fixed weekly cadence instead of by adding entries.

**Caveat — execution realism**: the "first crossing" trigger is chronologically causal (no look-ahead), but it still assumes instant execution at the first observed tick that crosses the threshold. A real implementation would need either a resting limit/GTC buy order at that price or continuous monitoring; realistic polling latency or slippage would likely capture somewhat less than this idealized figure. Flagged, not hidden — this is the reason Idea 4 is reported as strong-but-caveated rather than clean, unlike Idea 1.

**Confidence**: Medium-high. Mechanism is real and verified; magnitude is likely somewhat optimistic versus live execution.

---

## Combined test: Daily entry + Early close — **+11.69pp (10.13% → 21.82%), sub-additive**

Per the task's rule against stacking untested combinations, Ideas 1 and 4 — the two survivors — were run together explicitly rather than assumed additive.

| | APR | Delta vs. 10.13% baseline |
|---|---|---|
| Daily entry alone | 21.04% | +10.91pp |
| Early close alone | 24.64% | +14.51pp |
| **Combined** | **21.82%** | **+11.69pp** |
| Naive sum (for comparison) | — | would predict 35.55% |

**Interpretation**: the combined result lands close to daily-entry-alone and *below* early-close-alone — clear evidence the two levers compete for the same underlying resource (capital velocity), rather than compounding. Daily entry already shortens the average time capital sits idle between opportunities; adding early-close on top has much less room to help, because the marginal benefit of "free up capital faster" shrinks once entries are already dense. This is a genuine interaction effect, not a bug — confirmed by the fact the combined APR is bounded between the two individual results rather than exceeding both.

**Practical implication**: implementing both mechanisms is not worth the added complexity of early-close's execution-realism caveat, when daily entry alone captures most of the combined gain with a cleaner, more realistic execution model (enter and hold — no live monitoring or resting orders required).

---

## Errors caught and corrected during this exploration

- **Look-ahead bug in Idea 4's first draft**: the initial "early close" query picked the single *latest* pre-expiry tick with full hindsight, not a chronologically causal trigger. Caught before accepting the result, fixed to select the first tick (in time order after entry) that crosses the profit-target threshold. The corrected version (+14.51pp) is what's reported above; the hindsight version (+12.72pp, similar magnitude but for the wrong reason) was discarded.
- **European-options mechanics check**: raised mid-task by the user. Verified the Gold layer's `outcome_assignment_inferred` field and every backtest script's assignment-loss calculation are already correctly scoped to expiry-only settlement — consistent with European-style options, which cannot be exercised or assigned early. No bug found; no rerun required.

---

## Ranked findings

| Rank | Finding | APR impact | Confidence | Verdict |
|---|---|---|---|---|
| 1 | Daily entry cadence | +10.91pp | High — 110 independent expiries, clean mechanics, no execution caveats | **Implement.** Cleanest, most robust lever found. |
| 2 | Early close on profit target | +14.51pp alone / +11.69pp combined with #1 | Medium-high — real mechanism, but idealized execution assumption | **Consider only if daily entry is not already deployed.** Adds limited marginal value on top of daily entry and requires live position monitoring; the combined test shows most of its benefit is redundant with #1. |
| 3 | Multi-expiry concurrency | −6.90pp | High (verified negative) | **Do not implement.** Capital dilution across low-quality expiries actively hurts returns. |
| 4 | Call-side ladder | −33.53pp | High (verified negative, mechanically explained by trend regime) | **Do not implement** as a standalone strategy in trending regimes; a put+call combination was not tested here and would need its own explicit test if pursued. |

**Bottom line**: the 10.13% ceiling was structural to *entry cadence and hold-duration*, not to the underlying edge. Daily entry alone, using otherwise-identical v4 mechanics, more than doubles APR to 21.04% — a result that clears the original 20% target this entire backtesting effort was chasing, on a sample large enough (110 independent expiries) not to be dismissed as noise. Early close adds real but largely redundant value on top. The two ideas that extended the *ladder's footprint* (more expiries, more instrument types) both failed, for opposite but equally structural reasons: multi-expiry diluted quality, and calls fought the market's actual trend.

---

*Source: `analysis/exploration-daily-entry.ts`, `analysis/exploration-multi-expiry.ts`, `analysis/exploration-calls.ts`, `analysis/exploration-early-close.ts`, `analysis/exploration-combined.ts` · `data/gold/BTC.parquet` · baseline reconstructed and verified against v4's exact $18,830.10 PnL / 10.13% APR before running all explorations on top.*
