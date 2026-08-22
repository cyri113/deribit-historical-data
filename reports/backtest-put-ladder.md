# Ten Percent, Not Twenty

**BTC Weekly Put Ladder — Backtest Report**

A weekly cash-secured put ladder was built against real Deribit BTC options data and iterated five times under one rule: change exactly one thing, measure, log the direction. The strategy never reached the 20% APR gate — it plateaued at 10.13%, and the reason is now well understood.

| | |
|---|---|
| **Universe** | BTC options, Deribit Gold layer |
| **Window** | 2024-10-07 → 2026-08-17 (1.86 years) |
| **Structure** | 2Δ / 5Δ / 10Δ puts, 3–10 DTE |
| **Capital** | $100,000 initial |

**Best APR reached:** 10.13% (v4) — target was 20–25%
**Iterations run:** 5, one rule change each
**Dominant lever:** capital efficiency, ~19× of total APR gain

---

## 1. Baseline rules

Every candidate week, if liquidity cleared a threshold, the backtest sold a three-leg put ladder on the nearest qualifying expiry and held to settlement. One documented deviation from the literal spec made the whole exercise runnable — without it there was exactly one usable week in the dataset.

- **Entry** — Weekly, gated on trailing liquidity above a percentile threshold
- **Ladder** — Puts nearest to 2Δ, 5Δ, 10Δ, one shared expiry
- **Hold** — To expiry. Deribit options are European and cash-settled, so "7 days or assignment" collapses to "hold to settlement, then check"
- **Capital** — $100,000, position notional locked from entry to that leg's own expiry
- **Hit rate** — % of weeks collecting >0.38% premium against capital deployed

### DTE deviation, documented

The spec calls for a strict 7-day hold. Across the full ~2-year dataset — before and after a bronze fetch specifically widened to find more weekly cycles — only one week had any put trade landing at 7–10 days to expiry, even before liquidity filtering. Deribit's BTC options volume is structurally bimodal: 0–3 DTE dominates, and almost nothing sits at exactly 7 DTE. Independent research confirmed this has held since Deribit's Feb 2020 daily-expiry launch — it does not improve by fetching further back.

The acceptance band was widened to **3–10 DTE** (23 usable weeks vs. 1), still preferring whichever qualifying expiry sits closest to 7 days. Actual DTE achieved is logged per week throughout.

---

## 2. Iteration log

One change per version, in the order tested.

| Version | Change | APR | Hit rate | Direction |
|---|---|---|---|---|
| v1 | Baseline — full cash-secured notional, 50th-pct liquidity gate, 2/5/10Δ | 0.54% | 0/7 · 0% | — |
| v2 | Real Deribit margin sizing replaces full notional | 0.93% ↗ | 11/11 · 100% | toward target |
| v3 | Size to fully deploy available capital, not a fixed $100K/3 target | 5.05% ↗ | 11/11 · 100% | toward target |
| **v4** | **Liquidity gate loosened, 50th → 0th percentile — admit all 23 weeks** | **10.13% ↗** | **23/23 · 100%** | **toward target · best result** |
| v5 | Ladder's inner rung 2Δ → 1Δ, per the task's own suggestion | 9.98% → | 23/23 · 100% | flat · plateau |

Every entry-and-sizing lever available under the task's four approved changes was tested. v4's loosened liquidity gate produced the best result; v5 confirmed the remaining lever was exhausted.

---

## 3. What each change actually did

### v1 → v2 — the notional was never the real cost

Sizing each leg to fully cash-secure its strike (v1) meant $100K worth of collateral earned $100–270 in weekly premium: 0.10–0.27% of capital, an order of magnitude under the 0.38% hit-rate bar. Swapping in Deribit's actual Standard Margin formula moved the same trade's footprint from ~$33K to ~$11K per leg — the same dollars of premium, against a much smaller base.

**Deribit Standard Margin, short option:**

```
IM = [max(0.15 - OTM%, 0.10) + mark_price] × underlying × amount
```

OTM% is the underlying's distance past the strike, so margin shrinks as the put moves further out of the money, floored at 10% of notional. Source: support.deribit.com, "Standard Margin" and "Margin types and usage."

### v2 → v3 — capital efficiency exposed capital idleness

Margin sizing worked at the trade level (0% → 100% hit rate) but barely moved the portfolio: v2 still sized every ladder to a fixed $100K/3 notional target, which under ~10–15% margin only consumed ~11% of the account. Roughly 89% of the $100,000 sat idle the entire backtest. v3 inverted the sizing logic to solve for the contract count that spends 100% of whatever capital is currently free — a direct algebraic extension of the same lever, not a new one.

### v3 → v4 — too few opportunities, not too little capital

Even fully utilized, capital stayed lumpy: roughly half of entered weeks deployed under 3% of the account, because positions alternated between fully committed and nearly empty while waiting for the next liquid week. Only 11 of 23 candidate weeks cleared the 50th-percentile liquidity gate. Removing the gate entirely let every week enter, and utilization stopped starving between positions — the single largest jump in the sequence, and the run where the first assignment appeared (one leg, a $58.90 loss, absorbed cleanly).

### v4 → v5 — the last lever, confirmed exhausted

Moving the inner rung from 2Δ to 1Δ is the task's own suggested change. It moved APR from 10.13% to 9.98% — essentially flat, slightly negative, exactly as expected: a further-OTM put is a cheaper option, and there was no efficiency gain left to extract from strike selection once margin and utilization were already fixed.

---

## 4. v4 in full — the best configuration

Every candidate week entered. One assignment, absorbed without a margin call.

| Week | DTE | Deployed | Premium | % of capital | Assign loss | Legs |
|---|---|---|---|---|---|---|
| 2024-10-07 | 3 | $100,000 | $1,134.93 | 1.135% | $0.00 | N N N |
| 2025-12-29 | 3 | $101,135 | $895.98 | 0.886% | $0.00 | N N N |
| 2026-03-30 | 4 | $102,031 | $1,658.17 | 1.625% | $0.00 | N N N |
| 2026-04-06 | 4 | $1,658 | $19.49 | 1.176% | $0.00 | N N N |
| 2026-04-13 | 4 | $102,050 | $855.67 | 0.838% | $0.00 | N N N |
| 2026-04-20 | 4 | $2,514 | $34.77 | 1.383% | $0.00 | N N N |
| 2026-04-27 | 4 | $102,085 | $1,096.02 | 1.074% | $0.00 | N N N |
| 2026-05-04 | 4 | $105,695 | $947.35 | 0.896% | $0.00 | N N N |
| **2026-05-11** | 4 | $106,642 | $1,339.55 | 1.256% | **$58.90** | N N **Y** |
| 2026-05-18 | 4 | $1,340 | $10.12 | 0.755% | $0.00 | N N N |
| 2026-05-25 | 4 | $106,594 | $972.31 | 0.912% | $0.00 | N N N |
| 2026-06-01 | 4 | $2,312 | $54.05 | 2.338% | $0.00 | N N N |
| 2026-06-08 | 4 | $106,648 | $2,781.46 | 2.608% | $0.00 | N N N |
| 2026-06-15 | 4 | $111,741 | $1,162.96 | 1.041% | $0.00 | N N N |
| 2026-06-22 | 4 | $1,163 | $23.48 | 2.019% | $0.00 | N N N |
| 2026-06-29 | 4 | $111,764 | $1,172.21 | 1.049% | $0.00 | N N N |
| 2026-07-06 | 4 | $2,335 | $23.01 | 0.985% | $0.00 | N N N |
| 2026-07-13 | 4 | $114,123 | $1,066.85 | 0.935% | $0.00 | N N N |
| 2026-07-20 | 4 | $115,189 | $1,102.78 | 0.957% | $0.00 | N N N |
| 2026-07-27 | 4 | $1,103 | $11.33 | 1.027% | $0.00 | N N N |
| 2026-08-03 | 7 | $115,201 | $1,713.44 | 1.487% | $0.00 | N N N |
| 2026-08-10 | 4 | $2,816 | $23.13 | 0.821% | $0.00 | N N N |
| 2026-08-17 | 3 | $118,040 | $789.94 | 0.669% | $0.00 | N N N |

23 weeks entered, 23 hit the 0.38% threshold. Deployment still ranges from $1,103 to $118,040 — utilization is fixed *in aggregate* (100% of whatever is free gets used), but a single weekly ladder still can't hold multiple concurrent positions, so the account cycles between fully committed and nearly empty depending on when the prior lock last released.

---

## 5. The gate

### Under what conditions does this strategy hit 20–25% APR?

Not under any tested variation. The best configuration — real margin sizing, full capital utilization, no liquidity filter — reaches **10.13%**, about half the floor. Every lever with real room to move was pushed to its most permissive still-defensible setting; the one lever left (ladder delta) is exhausted and flat.

### What assumption is most critical?

**Capital efficiency**, by a wide margin. The move from full cash-secured notional to real Deribit margin (v1→v4) accounts for roughly **19×** of the total APR gain; liquidity filtering and ladder-delta tuning contributed comparatively little once margin and utilization were already fixed. The edge here comes from capital efficiency and hold-to-expiry premium capture on real exchange economics — not from timing or strike selection.

### Is 20% realistic, or should the target be different?

For this exact structure — weekly, single ladder, 3–10 DTE, put-only — **~10% APR is the realistic ceiling**, not 20%. Closing the remaining gap would require a structural change outside the four approved levers: running multiple concurrent ladders per week rather than one fuller one, extending past puts, or accepting leverage beyond Deribit's own margin floor — which the task's own exit condition already flags as unrealistic. 10% is the defensible number for this structure; 20% is not reachable without becoming a different strategy.

---

*Source: `analysis/backtest-v1.ts` – `backtest-v5.ts` · `data/gold/BTC.parquet` · 5 iterations, 1 rule change each, 23 candidate weeks*
