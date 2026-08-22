# Four Investigations, No Lever

**Research-Backed Improvements to the Put Ladder Strategy**

The v4 backtest (10.13% APR, 23/23 weeks entered, 100% hit rate) was tested against four research-motivated hypotheses: Kelly-regime sizing, volatility-regime filtering, IV mean-reversion entry timing, and skew-based tail hedging. None independently clears the task's own 0.5pp APR-lift bar. One (skew) is mechanically correct but unproven on a single loss event; the other three move APR flat-to-negative relative to their hypotheses — in two cases, in the *opposite* direction from what was predicted.

| | |
|---|---|
| **Baseline** | v4: 10.13% APR, 23 weeks, 1 assignment |
| **Investigations run** | 4, one research area each |
| **Independent lift found** | 0 of 4 clear the >0.5pp gate |
| **Combined recommendation** | None — do not combine per the task's own rule |

---

## 0. Citation check, before anything else

Three of the four cited papers are real and verified to say what the task claims:

| Citation | Status |
|---|---|
| Wysocki (2025, arXiv:2508.16598) | ✅ Real. "Sizing the Risk: Kelly, VIX, and Hybrid Approaches in Put-Writing on Index Options." Confirms hybrid Kelly+VIX-regime sizing outperforms fixed sizing, especially in low-vol regimes. |
| Banerjee (SSRN 5920642) | ✅ Real. "Detecting Volatility Regimes in Crypto Markets using Realized Volatility Structure and Normalized Momentum." Confirmed: classifies Expansion/Neutral/Contraction from short-term vs. long-term realized-vol ratio on BTC data. Dated Dec 2025, not 2026 as stated in the task — minor. |
| Ning & Lee (2024) | ✅ Real. 100 most-traded US equities, 2018–2023. Confirmed: >65% of tickers show statistically significant IV mean reversion. |
| **"Patel et al. (2024)"** | ❌ **Not real.** The 2.6 / −2.8 Sharpe figures are genuine, but they describe a short-vol strategy's 2017 (pre-XIV-blowup) vs. 2018 (XIV-blowup) performance from a trading blog — not a 2024 academic paper by anyone named Patel. Real numbers, fabricated attribution. |

The underlying claim behind Investigation 4 — short volatility has fat left-tail risk — is well-established regardless of the citation issue. This report does not attribute the 2.6/−2.8 figures to Patel anywhere below.

---

## 1. Kelly Criterion + Regime Sizing — **Δ = 0.00pp**

**Method**: computed a discrete-outcome Kelly fraction (win/loss classified by *assignment*, not net weekly PnL sign — net PnL stayed positive even in the one assigned week, so a PnL-sign filter finds zero "losses" and hides the real signal). Cross-checked against mean-variance Kelly on the raw weekly-return series, and computed per-regime Kelly fractions using `vol_regime`.

**Result**:
- Discrete-outcome Kelly: **f\* = 95.6%** of capital — close to what v4 already deploys.
- Mean-variance Kelly: **f\* = 50,178%** — numerically unstable, not a real sizing signal. Returns cluster too tightly (near-zero variance, zero net-negative weeks) for the formula to resolve a stable answer.
- Per-regime Kelly fractions (175,000%–400,000%) are equally unstable, for the same reason.

**Why it moved nothing**: this 23-week sample has essentially no realized downside — one assignment, and that week was still net profitable. Kelly's loss-magnitude term needs a real loss distribution to size against; with one data point, it can only confirm that v4's already-aggressive full-capital-utilization approach isn't leaving obvious money on the table, not that a smarter formula would unlock more.

**Gate**: APR stayed at 10.13% (< 12%). **Not the lever.**

---

## 2. Volatility Regime Detection — **Δ = −3.39pp**

**Method**: classified each week Expansion / Neutral / Contraction per Banerjee's framework — short-term (7-day) vs. long-term (30-day) realized volatility ratio, both computed in matching decimal-fraction units (see caveat below). Tested skipping Contraction weeks entirely.

**Result**:

| Regime | n | Return on capital | Hit rate | Avg premium | Assignments |
|---|---|---|---|---|---|
| Expansion | 2 | 2.60% | 100% | 2.473% | 0/2 |
| Neutral | 10 | 1.12% | 100% | 1.127% | 1/10 |
| Contraction | 9 | 0.92% | 100% | 1.016% | 0/9 |

Skipping the 9 Contraction weeks: APR **10.13% → 6.74%**.

**Why it backfired**: the hypothesis assumed Contraction (falling vol) is where risk concentrates. On this data it isn't — the one assignment happened in a *Neutral* week, and Contraction weeks, despite the lowest average premium, had zero assignments and were consistently profitable. Removing 9 of 23 weeks just shrinks total return without cutting the risk it was meant to avoid.

**Gate**: filtered APR (6.74%) is well below both the 10.13% baseline and the 12% threshold. **Flagged as noise — the regime signal doesn't transfer to an actionable filter on this sample.**

---

## 3. IV Mean Reversion / Entry Timing — **Δ = −1.68pp (real signal, wrong direction)**

**Method**: split the 23 weeks into IV-percentile tertiles using Gold's own `iv_percentile_90day` (already look-ahead-safe from an earlier pipeline fix). Compared median premium, forward move, and assignment rate per tertile; computed the correlation between entry IV percentile and premium collected.

**Result**:

| Tertile | n | IV pctl range | Median premium | Median fwd move | Assignment rate |
|---|---|---|---|---|---|
| Low | 7 | 14–30 | 0.896% | 3.53% | 0% |
| Mid | 8 | 31–46 | 1.135% | −0.57% | 0% |
| High | 8 | 49–94 | 1.625% | 2.69% | 13% |

Correlation(IV percentile at entry, premium collected): **r = 0.835**.

Low-IV-only APR: 2.65%. High-IV-only APR: 4.33%. Gap: **−1.68pp**, Low underperforming High.

**Why it's real but backwards**: the correlation is strong and not noise — but it reflects the standard volatility risk premium (sellers get paid more when IV is elevated), not IV mean reversion specifically. Avoiding High-IV weeks would have meant giving up the richest premium in the sample; the extra 13% assignment rate there didn't offset the premium gain in net terms.

**Gate**: the task's gate ("Low-IV > High-IV by >1% is actionable") assumed the sign would run the other way. It doesn't. **A Low-IV entry filter would cost APR, not add it.**

---

## 4. Tail Risk & Skew — **directionally correct, statistically unproven**

**Method**: computed a skew proxy per week — `(IV at the 2-delta leg − IV at the 10-delta leg) / IV at the 10-delta leg` — using real traded legs, not a synthetic ATM point. Modeled a tail hedge using a genuine ~1-delta put's real market premium each week (not a synthetic cost), sized to match the 2-delta leg's contract count.

**Result**:

| Skew tertile | n | Skew range | Median max loss (theoretical) | Assignments |
|---|---|---|---|---|
| Low | 7 | 0.12–0.26 | $22,737 | 0/7 |
| Mid | 8 | 0.28–0.33 | $1,001,888 | 0/8 |
| High | 8 | 0.33–0.57 | $927,994 | **1/8** |

The one realized assignment (2026-05-11, $58.90 loss) **did occur in the High-skew tertile** — the skew signal correctly flagged the riskiest bucket.

Hedge economics: total 1-delta put cost across 8 High-skew weeks = **$402.31, 6.6% of premium collected** (well under the 20% cost gate). Modeled benefit = the full $58.90 loss prevented (100% of tail loss, above the 50% gate) — but net cost ($402) exceeds net benefit ($58.90) on this single realized event.

**Why this one is different from 1–3**: both gate thresholds are technically cleared (cost <20% ✓, tail-loss-cut >50% ✓), but the underlying sample is one loss event. A single data point can demonstrate the mechanism works — it cannot establish whether systematic hedging pays for itself over time. **Directionally worth pursuing with more data; not actionable as stated.**

---

## Known data-quality caveat (found during this work, out of scope to fix here)

`realized_vol_7day` in the Gold layer is stored as a decimal fraction (~0.13), while `implied_volatility` is stored as a percentage number (~50). The existing `iv_minus_rv_gap` column silently mixes these units — it's dominated by the IV term and should not be trusted as-is. This investigation avoided the bug by computing all regime classification in matched decimal-fraction units directly (never comparing `realized_vol_7day` to `implied_volatility`). Flagged for a separate fix; not touched here.

---

## Synthesis

**Which investigation revealed the most APR lift?** None, by the task's own bar. Investigation 4 (skew/tail hedge) is the only one with a real, correctly-directed signal — skew genuinely flagged the week that got assigned — but it isn't independently APR-positive on this sample (hedge cost exceeded realized benefit).

**Single highest-priority change?** None qualifies for implementation as specified. If forced to rank by *mechanism quality* rather than realized APR: skew-based tail awareness (Investigation 4) > IV-level entry awareness (Investigation 3, though its actionable direction is the opposite of the hypothesis) > regime filtering (Investigation 2, wrong direction) > Kelly resizing (Investigation 1, no signal to act on).

**Combined estimate, top two changes?** Not computed — per the task's explicit rule ("do not combine all four unless each shows >0.5% independent APR lift"), and none does. Combining would be curve-fitting four negative-to-flat results into a positive-sounding number the data doesn't support.

**Still hitting the 10% floor, or can this push 12–15%?** Still at 10%. None of these four levers, individually or in combination, provides a defensible path to 12–15% on this dataset. The binding constraint remains what the original backtest already identified: trade frequency and structural capital deployment (v1→v4's real driver), not entry timing, regime filtering, or position sizing refinements on top of it.

---

## Ranked deliverable: improvements by estimated APR impact

| Rank | Change | Est. APR impact | Cost / complexity | Verdict |
|---|---|---|---|---|
| 1 | Skew-aware tail hedge (High-skew weeks only) | Unproven; mechanism correct, n=1 sample | Low — real market hedge, straightforward to implement | Worth tracking with more data; not implementable on current evidence |
| 2 | IV-level entry awareness | −1.68pp if filtering toward Low-IV (wrong direction) | Low | Do not implement as "prefer Low-IV" — if anything, the data argues for High-IV entries, which is already what v4 does implicitly via unrestricted entry |
| 3 | Regime-based entry filter (skip Contraction) | −3.39pp | Low | Do not implement — actively harmful on this sample |
| 4 | Kelly / regime-scaled position sizing | 0.00pp | Medium (formula + regime plumbing) | Do not implement — no signal to extract with this loss sample size |

**Bottom line**: none of these four research-motivated changes moves the strategy off its 10% ceiling. The sample (23 weeks, 1 assignment) is too thin to validate any of them — three investigations found real correlations, but correlations built on a single loss event or a 2–3-week regime bucket don't survive contact with an actionable gate. More data, not more clever sizing, is the actual next step.

---

*Source: `analysis/research-investigations.ts` · `data/gold/BTC.parquet` · reconstructs v4's exact 23-week entry set (verified: $18,830.10 PnL, 10.13% APR, exact match) before running all four investigations on top.*
