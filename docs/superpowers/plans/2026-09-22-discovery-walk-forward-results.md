# Discovery walk-forward: what actually predicts 10-session excess vs SPY

Run 2026-09-22T17:27:09Z · `npx tsx scripts/discovery-walk-forward.ts`

- **Universe** 1855 names with ≥ 200 daily bars (11 of 1866 seed rows dropped: no tape, or too short).
- **Dates** 188 sessions, 2025-12-03 → 2026-09-02, step 1. Warm-up 100 bars. Tape requested: `range=2y`, capped at 300 bars by `DBARS_MAX`.
- **Observations** 348,095 name-dates with readable features and a complete forward window; 324,258 of them pass production hygiene (price, liquidity, staleness, ETP).
- **Trade** signal on the close of *t* → entry at the **next session's open** → exit at the **close 10 sessions later**. Excess = name return − SPY return over the same calendar window, in pp. Hit = excess ≥ +1pp.
- **t** is the naive t-statistic of the mean over observations. **t_NW** is a Newey–West(10) t over the per-date means — the honest one, because consecutive dates share 9 of their 10 forward sessions and every name on a date moves with the market. Read t_NW; t is printed only because it is what a naive backtest would have reported.

## a. Lenses

Short lenses (weak, climax, unusual-down) are scored as **−excess**: the lens is right when the name falls. "dates" is the share of sessions on which the lens fired at least once. MAE is the mean worst drawdown from the entry price during the hold, in %.

| lens | n | mean pp | edge vs qualified | median pp | hit | t | t_NW | dates | MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| unusual-up | 12,467 | 0.14 | 0.04 | -0.19 | 42.8% | 1.5 | 0.5 | 99.5% | -6.0 |
| unusual-down | 10,941 | -0.42 | -0.32 | -0.13 | 43.1% | -4.8 | -1.1 | 99.5% | -5.9 |
| rs-leader | 5,982 | 1.10 | 1.00 | 0.13 | 46.5% | 6.4 | 1.6 | 100.0% | -8.6 |
| pullback | 16,460 | 0.21 | 0.11 | -0.18 | 43.7% | 2.7 | 0.4 | 100.0% | -6.9 |
| breakout | 740 | -0.25 | -0.35 | -0.91 | 38.1% | -0.8 | -0.2 | 84.0% | -5.8 |
| dip | 7,309 | 0.41 | 0.31 | -0.03 | 44.7% | 3.0 | 0.5 | 100.0% | -7.6 |
| weak | 12,443 | -0.75 | -0.65 | -0.20 | 44.0% | -8.1 | -0.5 | 100.0% | -7.2 |
| climax | 1,345 | 0.47 | 0.57 | 0.48 | 47.2% | 1.9 | 0.9 | 92.6% | -6.2 |
| **baseline: every name-date** | 348,095 | 0.53 | 0.43 | -0.16 | 42.3% | 4.8 | 1.2 | 100.0% | -5.6 |
| **baseline: hygiene-qualified** | 324,258 | 0.10 | 0.00 | -0.19 | 42.4% | 6.5 | 0.3 | 100.0% | -5.7 |

## b. Features — deciles and rank IC

Deciles are cross-sectional **within each date** over hygiene-qualified names, so D10 is "the top 10% of the market that day", never "the top 10% of history". IC is the Spearman correlation of the feature with forward excess inside a date; IC t = mean/(sd/√dates).

Note: within a single date SPY's return is a constant, so `rsSpy20` is a monotone shift of `ret20` and `rsSpy60` of `ret60` — their cross-sectional rank ICs are IDENTICAL by construction, and any difference below is null-handling alone. That is four columns carrying two independent signals, and the multiple-comparison count in §e is stated on that basis.

| feature | D1 mean | D1 hit | D10 mean | D10 hit | D10−D1 | IC | IC t | IC h1 | IC h2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bbWidthPctl120 | -0.08 | 41.1% | 0.49 | 44.1% | 0.58 | 0.0153 | 3.0 | 0.0112 | 0.0194 |
| rvol | -0.13 | 41.1% | 0.32 | 43.2% | 0.45 | 0.0105 | 2.7 | 0.0229 | -0.0019 |
| volTrend5 | -0.02 | 41.7% | 0.34 | 43.1% | 0.36 | 0.0108 | 2.3 | 0.0301 | -0.0085 |
| ddFrom20dHigh | 0.45 | 45.3% | -0.08 | 40.9% | -0.53 | -0.0209 | -2.3 | -0.0235 | -0.0183 |
| ret5 | 0.49 | 45.5% | 0.41 | 43.5% | -0.08 | -0.0147 | -1.6 | 0.0125 | -0.0419 |
| distTo52wHigh | 0.46 | 45.6% | -0.08 | 40.7% | -0.54 | -0.0109 | -1.0 | 0.0183 | -0.0402 |
| ret60 | 0.35 | 45.0% | 0.47 | 44.6% | 0.12 | -0.0108 | -1.0 | 0.0226 | -0.0441 |
| rsSpy60 | 0.34 | 45.0% | 0.47 | 44.6% | 0.12 | -0.0107 | -1.0 | 0.0226 | -0.0441 |
| distEma21Atr | 0.13 | 43.6% | 0.34 | 42.6% | 0.21 | -0.0064 | -0.7 | 0.0065 | -0.0193 |
| ret20 | 0.26 | 44.0% | 0.91 | 45.4% | 0.65 | -0.0061 | -0.7 | -0.0015 | -0.0106 |
| rsSpy20 | 0.26 | 44.0% | 0.91 | 45.4% | 0.65 | -0.0060 | -0.7 | -0.0015 | -0.0106 |
| rsi14 | 0.06 | 43.2% | 0.26 | 42.2% | 0.20 | -0.0056 | -0.6 | 0.0058 | -0.0170 |
| upDays10 | 0.20 | 43.4% | 0.18 | 42.7% | -0.02 | -0.0036 | -0.6 | 0.0069 | -0.0141 |
| ema50Slope20 | 0.28 | 44.5% | 0.82 | 46.0% | 0.54 | 0.0059 | 0.6 | 0.0273 | -0.0155 |

## c. Splits

### Regime (SPY above / below its own 50-EMA on the signal date)

151 of 188 signal dates are SPY-above-50EMA.

| lens | n up | mean up | n down | mean down |
|---|---:|---:|---:|---:|
| unusual-up | 10468 | -0.03 | 1999 | 1.03 |
| unusual-down | 7779 | -0.48 | 3162 | -0.27 |
| rs-leader | 4347 | 1.55 | 1635 | -0.08 |
| pullback | 12469 | 0.25 | 3991 | 0.10 |
| breakout | 629 | -0.19 | 111 | -0.60 |
| dip | 5181 | -0.50 | 2128 | 2.61 |
| weak | 10018 | -0.42 | 2425 | -2.09 |
| climax | 1199 | -0.09 | 146 | 5.00 |
| **baseline** | 279547 | 0.28 | 68548 | 1.56 |

### Exchange

| lens | n US | mean US | n LSE | mean LSE |
|---|---:|---:|---:|---:|
| unusual-up | 10760 | 0.32 | 1707 | -0.96 |
| unusual-down | 9338 | -0.54 | 1603 | 0.28 |
| rs-leader | 5598 | 1.15 | 384 | 0.44 |
| pullback | 15064 | 0.27 | 1396 | -0.47 |
| breakout | 563 | -0.24 | 177 | -0.28 |
| dip | 6053 | 0.39 | 1256 | 0.49 |
| weak | 11345 | -0.77 | 1098 | -0.56 |
| climax | 1154 | 0.60 | 191 | -0.36 |
| **baseline** | 282987 | 0.15 | 65108 | 2.19 |

### Halves (stability)

First half 2025-12-03 → 2026-04-20; second half 2026-04-21 → 2026-09-02.

| lens | n h1 | mean h1 | hit h1 | n h2 | mean h2 | hit h2 |
|---|---:|---:|---:|---:|---:|---:|
| unusual-up | 6121 | 0.97 | 45.6% | 6346 | -0.66 | 40.0% |
| unusual-down | 5681 | -0.45 | 42.1% | 5260 | -0.38 | 44.3% |
| rs-leader | 3023 | 1.56 | 48.5% | 2959 | 0.64 | 44.4% |
| pullback | 8055 | 0.98 | 48.3% | 8405 | -0.53 | 39.3% |
| breakout | 297 | 0.97 | 42.8% | 443 | -1.07 | 35.0% |
| dip | 3905 | 1.81 | 50.0% | 3404 | -1.21 | 38.6% |
| weak | 6285 | -0.47 | 44.5% | 6158 | -1.03 | 43.6% |
| climax | 708 | 0.56 | 46.3% | 637 | 0.36 | 48.2% |
| **baseline** | 173725 | 1.19 | 43.8% | 174370 | -0.12 | 40.9% |

### Feature IC by split

| feature | IC up | IC down | IC US | IC LSE | IC t h1 | IC t h2 |
|---|---:|---:|---:|---:|---:|---:|
| bbWidthPctl120 | 0.0164 | 0.0109 | 0.0201 | 0.0106 | 1.6 | 2.6 |
| rvol | 0.0040 | 0.0369 | 0.0160 | -0.0106 | 4.3 | -0.4 |
| volTrend5 | -0.0005 | 0.0568 | 0.0173 | -0.0120 | 4.3 | -1.6 |
| ddFrom20dHigh | -0.0061 | -0.0812 | -0.0188 | -0.0086 | -1.8 | -1.4 |
| ret5 | -0.0149 | -0.0141 | -0.0121 | 0.0038 | 1.1 | -3.1 |
| distTo52wHigh | -0.0037 | -0.0407 | -0.0095 | 0.0030 | 1.3 | -2.4 |
| ret60 | -0.0076 | -0.0236 | -0.0068 | -0.0321 | 1.5 | -3.0 |
| rsSpy60 | -0.0076 | -0.0236 | -0.0068 | -0.0321 | 1.5 | -3.0 |
| distEma21Atr | 0.0032 | -0.0454 | -0.0024 | -0.0003 | 0.5 | -1.5 |
| ret20 | 0.0132 | -0.0846 | -0.0028 | -0.0116 | -0.1 | -0.9 |
| rsSpy20 | 0.0132 | -0.0847 | -0.0028 | -0.0116 | -0.1 | -0.9 |
| rsi14 | 0.0053 | -0.0501 | -0.0014 | -0.0013 | 0.5 | -1.3 |
| upDays10 | -0.0042 | -0.0014 | -0.0041 | 0.0282 | 0.9 | -1.4 |
| ema50Slope20 | 0.0133 | -0.0241 | 0.0100 | -0.0140 | 1.9 | -1.1 |

## d. Composite top-decile test

Equal-weight mean of within-date percentile ranks, top decile taken each date.

**In-sample selection** (IC > 0 in both halves and |IC t| ≥ 2 over the whole sample): bbWidthPctl120

| bucket | n | mean pp | median pp | hit | t | t_NW | MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|
| composite D10 | 33,386 | 0.49 | 0.09 | 44.1% | 9.9 | 1.6 | -5.7 |
| composite D1 | 32,313 | -0.08 | -0.31 | 41.1% | -1.9 | -0.2 | -5.5 |

Top decile beat SPY on **111/188 dates (59.0%)**.

**Out-of-sample** (features picked on the FIRST half only, scored on the second half only): rvol, volTrend5

| bucket | n | mean pp | hit | t | t_NW |
|---|---:|---:|---:|---:|---:|
| composite D10 (h2 only) | 16,333 | -0.35 | 40.0% | -4.9 | -0.6 |

Top decile beat SPY on **39/94 dates (41.5%)**.

## e. Verdict

**Nothing in this feature set clears the bar the brief set.** Over 348,095 walk-forward name-dates a seed name's unconditional 10-session excess over SPY is 0.53pp (hit 42.3%); production hygiene COSTS 0.43pp, leaving 0.10pp (hit 42.4%) — so the illiquid, cheap and stale names the floors throw away out-performed the ones they keep, and every lens below must be read against 0.10pp rather than against zero. On the brief's stated test (naive t ≥ 2.5 AND a positive mean in BOTH halves) only **rs-leader** survives, and it does not survive the overlap correction — 1.10pp mean, 46.5% hit, 1.56pp/0.64pp across the halves, naive t 6.4 but **t_NW 1.6**, short of 2 and therefore not an edge anyone should size on. The short lenses are INVERTED: unusual-down -0.42pp, weak -0.75pp — the names they flagged to sell went on to beat SPY, so in this sample they read as contrarian LONG signals rather than shorts. breakout (-0.25pp) sits at or below the qualified baseline of 0.10pp — selecting on it costs you money. On features, `ret20` (IC -0.0061, t -0.7; halves -0.0015/-0.0106, half-t -0.1/-0.9), `rsSpy20` (IC -0.0060, t -0.7; halves -0.0015/-0.0106, half-t -0.1/-0.9), `ddFrom20dHigh` (IC -0.0209, t -2.3; halves -0.0235/-0.0183, half-t -1.8/-1.4), `bbWidthPctl120` (IC 0.0153, t 3.0; halves 0.0112/0.0194, half-t 1.6/2.6) keep the SAME SIGN in both halves, and of those `ret20`, `rsSpy20`, `ddFrom20dHigh`, `bbWidthPctl120` also hold that sign on BOTH venues; **none reaches |t| ≥ 2.5 in both halves**, and 10 of the fourteen (ret5, ret60, rsSpy60, rvol, distEma21Atr, ema50Slope20, distTo52wHigh, upDays10, rsi14, volTrend5) change IC SIGN between the halves — the signature of a feature fitting the regime rather than the market. The composite settles it: picked in-sample the top decile returns 0.49pp (hit 44.1%, naive t 9.9, t_NW 1.6, beating SPY on 59.0% of dates), but selected honestly on the first half and scored on the second it returns -0.35pp (hit 40.0%, t_NW -0.6), beating SPY on only 41.5% of dates — an in-sample edge that does not survive one honest split is not an edge. **The strongest honest ranking available today** is therefore not a ranking of these fourteen features at all: it is (1) rs-leader as a WATCHLIST, not a sized call, (2) `ddFrom20dHigh` (IC -0.0209) and `bbWidthPctl120` (IC 0.0153) — the only features that hold one IC sign across both halves AND both venues while reaching |t| ≥ 2 overall — as a mild tiebreak, and (3) an explicit acknowledgement that the current board showing 0 sized calls is the correct output of this data rather than a bug in the scoring. Rebuilding the score on top of these features would be fitting noise; what the engine needs first is either a longer tape (300 bars is 9.0 months of signal dates and one regime) or features that are not all measuring the same trailing price move.

**Multiple-comparison and honesty caveats.** 14 features — of which `ret20`/`rsSpy20` and `ret60`/`rsSpy60` are rank-identical, so 12 independent — times (whole sample + 2 halves + 2 regimes + 2 exchanges), plus 8 lenses times the same splits, is ~130 comparisons; at α = 0.05 roughly 6 "significant" results are expected from pure noise, which is why nothing above is claimed on a single naive t. The forward windows overlap (10 sessions, stepped daily) and the cross-section is correlated within each date, so the naive t is inflated by something like √10 before the cross-sectional correlation is even counted — that is why t_NW (Newey–West, 10 lags, on the per-date mean series) is the number every claim leans on and why a naive t of 6.4 becomes 1.6. The sample is 188 signal dates spanning 9.0 months with SPY above its 50-EMA on 151 of them: this is one regime, and nothing here has been tested through a drawdown. There are no transaction costs, no borrow costs on the short lenses, no slippage on the next-day open and no bid-ask — the LSE column in particular (mean 2.19pp baseline, a full 2.04pp above US) is measured on closing prices of names whose real spreads are not in this data. Finally the universe is TODAY's index membership, so every name in it survived to today and nothing that was delisted, taken over or demoted during the window appears at all; the baseline excess of 0.53pp is an upper bound for that reason alone.


---

## 20-session horizon

Run 2026-09-22T17:28:27Z · `npx tsx scripts/discovery-walk-forward.ts --horizon 20 --append`

- **Universe** 1855 names with ≥ 200 daily bars (11 of 1866 seed rows dropped: no tape, or too short).
- **Dates** 178 sessions, 2025-12-03 → 2026-08-19, step 1. Warm-up 100 bars. Tape requested: `range=2y`, capped at 300 bars by `DBARS_MAX`.
- **Observations** 329,545 name-dates with readable features and a complete forward window; 306,964 of them pass production hygiene (price, liquidity, staleness, ETP).
- **Trade** signal on the close of *t* → entry at the **next session's open** → exit at the **close 20 sessions later**. Excess = name return − SPY return over the same calendar window, in pp. Hit = excess ≥ +1pp.
- **t** is the naive t-statistic of the mean over observations. **t_NW** is a Newey–West(20) t over the per-date means — the honest one, because consecutive dates share 19 of their 20 forward sessions and every name on a date moves with the market. Read t_NW; t is printed only because it is what a naive backtest would have reported.

### a. Lenses

Short lenses (weak, climax, unusual-down) are scored as **−excess**: the lens is right when the name falls. "dates" is the share of sessions on which the lens fired at least once. MAE is the mean worst drawdown from the entry price during the hold, in %.

| lens | n | mean pp | edge vs qualified | median pp | hit | t | t_NW | dates | MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| unusual-up | 12,192 | 0.21 | -0.11 | -0.48 | 44.0% | 1.7 | 0.2 | 99.4% | -8.1 |
| unusual-down | 10,610 | -0.55 | -0.23 | 0.02 | 46.0% | -4.5 | -0.5 | 99.4% | -7.9 |
| rs-leader | 5,587 | 2.55 | 2.22 | 0.82 | 49.7% | 10.2 | 1.6 | 100.0% | -11.3 |
| pullback | 15,054 | 0.09 | -0.23 | -1.15 | 42.9% | 0.8 | -0.1 | 100.0% | -9.3 |
| breakout | 708 | 0.05 | -0.27 | -0.58 | 41.9% | 0.1 | 0.4 | 83.1% | -8.0 |
| dip | 7,159 | -0.06 | -0.38 | -1.10 | 42.3% | -0.4 | 0.3 | 100.0% | -10.2 |
| weak | 11,770 | -1.23 | -0.91 | -0.51 | 44.9% | -9.0 | -0.4 | 100.0% | -9.6 |
| climax | 1,308 | -0.22 | 0.10 | 0.21 | 47.2% | -0.6 | 0.6 | 93.3% | -8.6 |
| **baseline: every name-date** | 329,545 | 0.80 | 0.48 | -0.27 | 44.4% | 6.7 | 1.0 | 100.0% | -7.6 |
| **baseline: hygiene-qualified** | 306,964 | 0.32 | 0.00 | -0.29 | 44.4% | 14.2 | 0.4 | 100.0% | -7.7 |

### b. Features — deciles and rank IC

Deciles are cross-sectional **within each date** over hygiene-qualified names, so D10 is "the top 10% of the market that day", never "the top 10% of history". IC is the Spearman correlation of the feature with forward excess inside a date; IC t = mean/(sd/√dates).

Note: within a single date SPY's return is a constant, so `rsSpy20` is a monotone shift of `ret20` and `rsSpy60` of `ret60` — their cross-sectional rank ICs are IDENTICAL by construction, and any difference below is null-handling alone. That is four columns carrying two independent signals, and the multiple-comparison count in §e is stated on that basis.

| feature | D1 mean | D1 hit | D10 mean | D10 hit | D10−D1 | IC | IC t | IC h1 | IC h2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bbWidthPctl120 | 0.07 | 42.7% | 1.08 | 46.9% | 1.00 | 0.0264 | 5.5 | 0.0221 | 0.0306 |
| ddFrom20dHigh | 0.83 | 45.7% | 0.15 | 42.4% | -0.68 | -0.0212 | -2.4 | -0.0283 | -0.0141 |
| rsSpy60 | 0.83 | 47.4% | 1.05 | 45.8% | 0.22 | -0.0222 | -2.0 | 0.0207 | -0.0651 |
| ret60 | 0.83 | 47.4% | 1.05 | 45.8% | 0.21 | -0.0222 | -2.0 | 0.0207 | -0.0652 |
| distTo52wHigh | 1.17 | 47.7% | 0.00 | 42.1% | -1.17 | -0.0212 | -1.9 | 0.0165 | -0.0590 |
| rvol | 0.07 | 43.7% | 0.49 | 44.8% | 0.42 | 0.0062 | 1.7 | 0.0177 | -0.0054 |
| volTrend5 | 0.36 | 44.0% | 0.51 | 44.5% | 0.15 | 0.0042 | 1.0 | 0.0241 | -0.0158 |
| ret20 | 0.55 | 45.5% | 2.12 | 48.5% | 1.57 | 0.0081 | 0.9 | 0.0091 | 0.0072 |
| rsSpy20 | 0.55 | 45.5% | 2.12 | 48.5% | 1.57 | 0.0081 | 0.9 | 0.0090 | 0.0072 |
| ret5 | 0.98 | 46.6% | 1.30 | 46.2% | 0.32 | -0.0080 | -0.8 | 0.0148 | -0.0308 |
| rsi14 | 0.20 | 44.8% | 0.71 | 44.1% | 0.50 | 0.0038 | 0.4 | 0.0124 | -0.0049 |
| distEma21Atr | 0.35 | 45.1% | 0.88 | 44.8% | 0.52 | 0.0035 | 0.4 | 0.0138 | -0.0068 |
| upDays10 | 0.44 | 45.2% | 0.41 | 44.6% | -0.03 | 0.0022 | 0.3 | 0.0167 | -0.0123 |
| ema50Slope20 | 0.73 | 46.8% | 1.64 | 47.7% | 0.91 | 0.0015 | 0.1 | 0.0223 | -0.0193 |

### c. Splits

#### Regime (SPY above / below its own 50-EMA on the signal date)

141 of 178 signal dates are SPY-above-50EMA.

| lens | n up | mean up | n down | mean down |
|---|---:|---:|---:|---:|
| unusual-up | 10193 | 0.18 | 1999 | 0.38 |
| unusual-down | 7448 | -0.73 | 3162 | -0.13 |
| rs-leader | 3952 | 2.54 | 1635 | 2.56 |
| pullback | 11063 | -0.20 | 3991 | 0.90 |
| breakout | 597 | -0.15 | 111 | 1.10 |
| dip | 5031 | -0.72 | 2128 | 1.50 |
| weak | 9345 | -1.13 | 2425 | -1.63 |
| climax | 1162 | -0.98 | 146 | 5.84 |
| **baseline** | 260997 | 0.71 | 68548 | 1.14 |

#### Exchange

| lens | n US | mean US | n LSE | mean LSE |
|---|---:|---:|---:|---:|
| unusual-up | 10516 | 0.54 | 1676 | -1.81 |
| unusual-down | 9066 | -0.71 | 1544 | 0.38 |
| rs-leader | 5224 | 2.64 | 363 | 1.26 |
| pullback | 13767 | 0.26 | 1287 | -1.64 |
| breakout | 543 | -0.02 | 165 | 0.27 |
| dip | 5923 | -0.04 | 1236 | -0.19 |
| weak | 10705 | -1.27 | 1065 | -0.85 |
| climax | 1123 | -0.36 | 185 | 0.63 |
| **baseline** | 267927 | 0.44 | 61618 | 2.37 |

#### Halves (stability)

First half 2025-12-03 → 2026-04-13; second half 2026-04-14 → 2026-08-19.

| lens | n h1 | mean h1 | hit h1 | n h2 | mean h2 | hit h2 |
|---|---:|---:|---:|---:|---:|---:|
| unusual-up | 5716 | 1.11 | 47.5% | 6476 | -0.58 | 41.0% |
| unusual-down | 5514 | -0.67 | 45.3% | 5096 | -0.42 | 46.7% |
| rs-leader | 2948 | 3.86 | 51.0% | 2639 | 1.08 | 48.1% |
| pullback | 7685 | 1.63 | 47.8% | 7369 | -1.51 | 37.8% |
| breakout | 285 | 1.39 | 47.4% | 423 | -0.85 | 38.3% |
| dip | 3805 | 1.57 | 45.8% | 3354 | -1.92 | 38.5% |
| weak | 5997 | -0.66 | 45.4% | 5773 | -1.82 | 44.4% |
| climax | 588 | 0.90 | 47.1% | 720 | -1.14 | 47.2% |
| **baseline** | 164450 | 1.51 | 45.8% | 165095 | 0.10 | 43.0% |

#### Feature IC by split

| feature | IC up | IC down | IC US | IC LSE | IC t h1 | IC t h2 |
|---|---:|---:|---:|---:|---:|---:|
| bbWidthPctl120 | 0.0326 | 0.0024 | 0.0312 | 0.0212 | 3.4 | 4.3 |
| ddFrom20dHigh | -0.0029 | -0.0909 | -0.0208 | -0.0101 | -2.0 | -1.4 |
| rsSpy60 | -0.0239 | -0.0158 | -0.0183 | -0.0497 | 1.5 | -3.9 |
| ret60 | -0.0239 | -0.0158 | -0.0183 | -0.0497 | 1.5 | -3.9 |
| distTo52wHigh | -0.0135 | -0.0509 | -0.0210 | -0.0037 | 1.2 | -3.5 |
| rvol | 0.0005 | 0.0278 | 0.0074 | 0.0109 | 3.4 | -1.1 |
| volTrend5 | -0.0044 | 0.0368 | 0.0038 | 0.0240 | 4.1 | -2.7 |
| ret20 | 0.0244 | -0.0540 | 0.0106 | -0.0016 | 0.7 | 0.6 |
| rsSpy20 | 0.0244 | -0.0541 | 0.0106 | -0.0016 | 0.7 | 0.6 |
| ret5 | -0.0045 | -0.0213 | -0.0055 | -0.0063 | 1.2 | -2.2 |
| rsi14 | 0.0127 | -0.0304 | 0.0070 | -0.0036 | 1.0 | -0.4 |
| distEma21Atr | 0.0117 | -0.0275 | 0.0064 | -0.0018 | 1.1 | -0.5 |
| upDays10 | 0.0021 | 0.0025 | 0.0031 | 0.0097 | 1.9 | -1.3 |
| ema50Slope20 | 0.0036 | -0.0064 | 0.0060 | -0.0272 | 1.9 | -1.1 |

### d. Composite top-decile test

Equal-weight mean of within-date percentile ranks, top decile taken each date.

**In-sample selection** (IC > 0 in both halves and |IC t| ≥ 2 over the whole sample): bbWidthPctl120

| bucket | n | mean pp | median pp | hit | t | t_NW | MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|
| composite D10 | 31,669 | 1.08 | 0.30 | 46.9% | 15.4 | 1.5 | -7.4 |
| composite D1 | 30,642 | 0.07 | -0.62 | 42.7% | 1.0 | 0.1 | -7.5 |

Top decile beat SPY on **118/178 dates (66.3%)**.

**Out-of-sample** (features picked on the FIRST half only, scored on the second half only): rvol, bbWidthPctl120, volTrend5

| bucket | n | mean pp | hit | t | t_NW |
|---|---:|---:|---:|---:|---:|
| composite D10 (h2 only) | 15,479 | 0.28 | 42.9% | 2.6 | 0.4 |

Top decile beat SPY on **46/89 dates (51.7%)**.

### e. Verdict

**Nothing in this feature set clears the bar the brief set.** Over 329,545 walk-forward name-dates a seed name's unconditional 10-session excess over SPY is 0.80pp (hit 44.4%); production hygiene COSTS 0.48pp, leaving 0.32pp (hit 44.4%) — so the illiquid, cheap and stale names the floors throw away out-performed the ones they keep, and every lens below must be read against 0.32pp rather than against zero. On the brief's stated test (naive t ≥ 2.5 AND a positive mean in BOTH halves) only **rs-leader** survives, and it does not survive the overlap correction — 2.55pp mean, 49.7% hit, 3.86pp/1.08pp across the halves, naive t 10.2 but **t_NW 1.6**, short of 2 and therefore not an edge anyone should size on. The short lenses are INVERTED: unusual-down -0.55pp, weak -1.23pp, climax -0.22pp — the names they flagged to sell went on to beat SPY, so in this sample they read as contrarian LONG signals rather than shorts. unusual-up (0.21pp), pullback (0.09pp), breakout (0.05pp), dip (-0.06pp) sit at or below the qualified baseline of 0.32pp — selecting on them costs you money. On features, `ret20` (IC 0.0081, t 0.9; halves 0.0091/0.0072, half-t 0.7/0.6), `rsSpy20` (IC 0.0081, t 0.9; halves 0.0090/0.0072, half-t 0.7/0.6), `ddFrom20dHigh` (IC -0.0212, t -2.4; halves -0.0283/-0.0141, half-t -2.0/-1.4), `bbWidthPctl120` (IC 0.0264, t 5.5; halves 0.0221/0.0306, half-t 3.4/4.3) keep the SAME SIGN in both halves, and of those `ddFrom20dHigh`, `bbWidthPctl120` also hold that sign on BOTH venues; bbWidthPctl120 reach |t| ≥ 2.5 in both halves, and 10 of the fourteen (ret5, ret60, rsSpy60, rvol, distEma21Atr, ema50Slope20, distTo52wHigh, upDays10, rsi14, volTrend5) change IC SIGN between the halves — the signature of a feature fitting the regime rather than the market. The composite settles it: picked in-sample the top decile returns 1.08pp (hit 46.9%, naive t 15.4, t_NW 1.5, beating SPY on 66.3% of dates), but selected honestly on the first half and scored on the second it returns 0.28pp (hit 42.9%, t_NW 0.4), beating SPY on only 51.7% of dates — an in-sample edge that does not survive one honest split is not an edge. **The strongest honest ranking available today** is therefore not a ranking of these fourteen features at all: it is (1) rs-leader as a WATCHLIST, not a sized call, (2) `ddFrom20dHigh` (IC -0.0212) and `bbWidthPctl120` (IC 0.0264) — the only features that hold one IC sign across both halves AND both venues while reaching |t| ≥ 2 overall — as a mild tiebreak, and (3) an explicit acknowledgement that the current board showing 0 sized calls is the correct output of this data rather than a bug in the scoring. Rebuilding the score on top of these features would be fitting noise; what the engine needs first is either a longer tape (300 bars is 8.5 months of signal dates and one regime) or features that are not all measuring the same trailing price move.

**Multiple-comparison and honesty caveats.** 14 features — of which `ret20`/`rsSpy20` and `ret60`/`rsSpy60` are rank-identical, so 12 independent — times (whole sample + 2 halves + 2 regimes + 2 exchanges), plus 8 lenses times the same splits, is ~130 comparisons; at α = 0.05 roughly 6 "significant" results are expected from pure noise, which is why nothing above is claimed on a single naive t. The forward windows overlap (20 sessions, stepped daily) and the cross-section is correlated within each date, so the naive t is inflated by something like √20 before the cross-sectional correlation is even counted — that is why t_NW (Newey–West, 20 lags, on the per-date mean series) is the number every claim leans on and why a naive t of 6.4 becomes 1.6. The sample is 178 signal dates spanning 8.5 months with SPY above its 50-EMA on 141 of them: this is one regime, and nothing here has been tested through a drawdown. There are no transaction costs, no borrow costs on the short lenses, no slippage on the next-day open and no bid-ask — the LSE column in particular (mean 2.37pp baseline, a full 1.93pp above US) is measured on closing prices of names whose real spreads are not in this data. Finally the universe is TODAY's index membership, so every name in it survived to today and nothing that was delisted, taken over or demoted during the window appears at all; the baseline excess of 0.80pp is an upper bound for that reason alone.


---

## 5-session horizon

Run 2026-09-22T17:29:30Z · `npx tsx scripts/discovery-walk-forward.ts --horizon 5 --append`

- **Universe** 1855 names with ≥ 200 daily bars (11 of 1866 seed rows dropped: no tape, or too short).
- **Dates** 193 sessions, 2025-12-03 → 2026-09-10, step 1. Warm-up 100 bars. Tape requested: `range=2y`, capped at 300 bars by `DBARS_MAX`.
- **Observations** 357,370 name-dates with readable features and a complete forward window; 332,886 of them pass production hygiene (price, liquidity, staleness, ETP).
- **Trade** signal on the close of *t* → entry at the **next session's open** → exit at the **close 5 sessions later**. Excess = name return − SPY return over the same calendar window, in pp. Hit = excess ≥ +1pp.
- **t** is the naive t-statistic of the mean over observations. **t_NW** is a Newey–West(5) t over the per-date means — the honest one, because consecutive dates share 4 of their 5 forward sessions and every name on a date moves with the market. Read t_NW; t is printed only because it is what a naive backtest would have reported.

### a. Lenses

Short lenses (weak, climax, unusual-down) are scored as **−excess**: the lens is right when the name falls. "dates" is the share of sessions on which the lens fired at least once. MAE is the mean worst drawdown from the entry price during the hold, in %.

| lens | n | mean pp | edge vs qualified | median pp | hit | t | t_NW | dates | MAE % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| unusual-up | 12,564 | 0.09 | 0.03 | -0.08 | 41.0% | 1.3 | -0.1 | 99.5% | -4.6 |
| unusual-down | 11,207 | -0.44 | -0.38 | -0.21 | 39.8% | -7.1 | -1.3 | 99.5% | -4.5 |
| rs-leader | 6,210 | 0.71 | 0.65 | 0.31 | 46.4% | 5.9 | 1.4 | 100.0% | -6.4 |
| pullback | 17,140 | 0.31 | 0.25 | 0.01 | 42.6% | 5.5 | 0.8 | 100.0% | -5.0 |
| breakout | 752 | -0.33 | -0.39 | -0.63 | 36.7% | -1.4 | 0.2 | 83.9% | -4.4 |
| dip | 7,451 | 0.19 | 0.13 | -0.11 | 42.9% | 2.0 | 0.7 | 100.0% | -5.9 |
| weak | 12,776 | -0.47 | -0.41 | -0.08 | 43.0% | -6.9 | -0.6 | 100.0% | -5.5 |
| climax | 1,352 | 0.05 | 0.11 | 0.40 | 45.5% | 0.3 | -0.2 | 92.2% | -4.5 |
| **baseline: every name-date** | 357,370 | 0.34 | 0.28 | -0.12 | 40.0% | 3.8 | 1.3 | 100.0% | -4.2 |
| **baseline: hygiene-qualified** | 332,886 | 0.06 | 0.00 | -0.13 | 40.1% | 5.5 | 0.3 | 100.0% | -4.2 |

### b. Features — deciles and rank IC

Deciles are cross-sectional **within each date** over hygiene-qualified names, so D10 is "the top 10% of the market that day", never "the top 10% of history". IC is the Spearman correlation of the feature with forward excess inside a date; IC t = mean/(sd/√dates).

Note: within a single date SPY's return is a constant, so `rsSpy20` is a monotone shift of `ret20` and `rsSpy60` of `ret60` — their cross-sectional rank ICs are IDENTICAL by construction, and any difference below is null-handling alone. That is four columns carrying two independent signals, and the multiple-comparison count in §e is stated on that basis.

| feature | D1 mean | D1 hit | D10 mean | D10 hit | D10−D1 | IC | IC t | IC h1 | IC h2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rvol | -0.11 | 38.8% | 0.15 | 41.0% | 0.26 | 0.0105 | 3.0 | 0.0215 | -0.0004 |
| volTrend5 | -0.07 | 39.2% | 0.17 | 41.0% | 0.25 | 0.0106 | 2.5 | 0.0291 | -0.0076 |
| ret5 | 0.39 | 44.0% | 0.14 | 41.3% | -0.25 | -0.0211 | -2.2 | 0.0044 | -0.0463 |
| ddFrom20dHigh | 0.28 | 43.8% | -0.17 | 37.8% | -0.45 | -0.0200 | -2.2 | -0.0132 | -0.0267 |
| distEma21Atr | 0.22 | 42.7% | 0.16 | 39.9% | -0.06 | -0.0165 | -1.8 | -0.0001 | -0.0328 |
| upDays10 | 0.07 | 40.7% | -0.06 | 39.1% | -0.13 | -0.0128 | -1.8 | 0.0055 | -0.0309 |
| rsi14 | 0.17 | 42.3% | 0.12 | 39.7% | -0.06 | -0.0147 | -1.6 | -0.0003 | -0.0289 |
| ret20 | 0.22 | 42.9% | 0.51 | 43.5% | 0.29 | -0.0080 | -0.8 | 0.0030 | -0.0188 |
| rsSpy20 | 0.22 | 42.9% | 0.51 | 43.5% | 0.29 | -0.0079 | -0.8 | 0.0030 | -0.0187 |
| distTo52wHigh | 0.27 | 43.9% | -0.05 | 37.9% | -0.32 | -0.0078 | -0.7 | 0.0166 | -0.0319 |
| bbWidthPctl120 | 0.03 | 39.6% | 0.23 | 41.1% | 0.19 | 0.0035 | 0.7 | 0.0010 | 0.0059 |
| ema50Slope20 | 0.11 | 42.1% | 0.49 | 44.2% | 0.38 | 0.0068 | 0.6 | 0.0191 | -0.0054 |
| ret60 | 0.16 | 42.8% | 0.28 | 43.2% | 0.12 | -0.0029 | -0.3 | 0.0158 | -0.0214 |
| rsSpy60 | 0.16 | 42.8% | 0.28 | 43.2% | 0.12 | -0.0029 | -0.3 | 0.0158 | -0.0214 |

### c. Splits

#### Regime (SPY above / below its own 50-EMA on the signal date)

155 of 193 signal dates are SPY-above-50EMA.

| lens | n up | mean up | n down | mean down |
|---|---:|---:|---:|---:|
| unusual-up | 10556 | 0.01 | 2008 | 0.52 |
| unusual-down | 8005 | -0.60 | 3202 | -0.05 |
| rs-leader | 4529 | 0.93 | 1681 | 0.11 |
| pullback | 13007 | 0.37 | 4133 | 0.12 |
| breakout | 639 | -0.31 | 113 | -0.45 |
| dip | 5299 | -0.01 | 2152 | 0.69 |
| weak | 10283 | -0.50 | 2493 | -0.37 |
| climax | 1206 | -0.27 | 146 | 2.71 |
| **baseline** | 286967 | 0.22 | 70403 | 0.81 |

#### Exchange

| lens | n US | mean US | n LSE | mean LSE |
|---|---:|---:|---:|---:|
| unusual-up | 10843 | 0.18 | 1721 | -0.47 |
| unusual-down | 9568 | -0.53 | 1639 | 0.05 |
| rs-leader | 5794 | 0.73 | 416 | 0.45 |
| pullback | 15683 | 0.35 | 1457 | -0.13 |
| breakout | 573 | -0.24 | 179 | -0.61 |
| dip | 6172 | 0.21 | 1279 | 0.13 |
| weak | 11662 | -0.48 | 1114 | -0.38 |
| climax | 1161 | 0.00 | 191 | 0.35 |
| **baseline** | 290517 | 0.09 | 66853 | 1.43 |

#### Halves (stability)

First half 2025-12-03 → 2026-04-22; second half 2026-04-23 → 2026-09-10.

| lens | n h1 | mean h1 | hit h1 | n h2 | mean h2 | hit h2 |
|---|---:|---:|---:|---:|---:|---:|
| unusual-up | 6194 | 0.73 | 44.6% | 6370 | -0.54 | 37.4% |
| unusual-down | 5818 | -0.39 | 38.9% | 5389 | -0.50 | 40.7% |
| rs-leader | 3043 | 0.76 | 46.9% | 3167 | 0.65 | 45.9% |
| pullback | 8215 | 0.52 | 44.3% | 8925 | 0.12 | 40.9% |
| breakout | 303 | 0.25 | 38.3% | 449 | -0.72 | 35.6% |
| dip | 3937 | 0.74 | 45.3% | 3514 | -0.42 | 40.2% |
| weak | 6371 | -0.24 | 43.8% | 6405 | -0.70 | 42.2% |
| climax | 750 | -0.21 | 42.1% | 602 | 0.37 | 49.7% |
| **baseline** | 177435 | 0.77 | 41.0% | 179935 | -0.09 | 39.0% |

#### Feature IC by split

| feature | IC up | IC down | IC US | IC LSE | IC t h1 | IC t h2 |
|---|---:|---:|---:|---:|---:|---:|
| rvol | 0.0059 | 0.0289 | 0.0151 | -0.0072 | 4.3 | -0.1 |
| volTrend5 | 0.0010 | 0.0501 | 0.0159 | -0.0112 | 4.7 | -1.4 |
| ret5 | -0.0227 | -0.0143 | -0.0174 | -0.0196 | 0.4 | -3.1 |
| ddFrom20dHigh | -0.0191 | -0.0236 | -0.0179 | -0.0115 | -1.1 | -1.9 |
| distEma21Atr | -0.0162 | -0.0180 | -0.0120 | -0.0127 | -0.0 | -2.3 |
| upDays10 | -0.0182 | 0.0094 | -0.0120 | 0.0158 | 0.6 | -2.7 |
| rsi14 | -0.0140 | -0.0174 | -0.0101 | -0.0100 | -0.0 | -2.0 |
| ret20 | -0.0049 | -0.0205 | -0.0043 | -0.0154 | 0.2 | -1.3 |
| rsSpy20 | -0.0048 | -0.0205 | -0.0043 | -0.0154 | 0.2 | -1.3 |
| distTo52wHigh | -0.0112 | 0.0061 | -0.0072 | 0.0068 | 1.1 | -2.1 |
| bbWidthPctl120 | 0.0057 | -0.0056 | 0.0070 | 0.0075 | 0.1 | 0.9 |
| ema50Slope20 | 0.0062 | 0.0093 | 0.0092 | -0.0044 | 1.2 | -0.4 |
| ret60 | -0.0072 | 0.0146 | -0.0002 | -0.0186 | 1.0 | -1.4 |
| rsSpy60 | -0.0072 | 0.0146 | -0.0002 | -0.0186 | 1.0 | -1.4 |

### d. Composite top-decile test

Equal-weight mean of within-date percentile ranks, top decile taken each date.

**In-sample selection** (IC > 0 in both halves and |IC t| ≥ 2 over the whole sample): _no feature qualified_


**Out-of-sample** (features picked on the FIRST half only, scored on the second half only): rvol, volTrend5

| bucket | n | mean pp | hit | t | t_NW |
|---|---:|---:|---:|---:|---:|
| composite D10 (h2 only) | 16,851 | -0.30 | 38.3% | -5.8 | -0.8 |

Top decile beat SPY on **43/97 dates (44.3%)**.

### e. Verdict

**Nothing in this feature set clears the bar the brief set.** Over 357,370 walk-forward name-dates a seed name's unconditional 10-session excess over SPY is 0.34pp (hit 40.0%); production hygiene COSTS 0.28pp, leaving 0.06pp (hit 40.1%) — so the illiquid, cheap and stale names the floors throw away out-performed the ones they keep, and every lens below must be read against 0.06pp rather than against zero. On the brief's stated test (naive t ≥ 2.5 AND a positive mean in BOTH halves) only **rs-leader, pullback** survives; corrected for the overlap the best of them is **rs-leader** — 0.71pp mean, 46.4% hit, 0.76pp/0.65pp across the halves, naive t 5.9 but **t_NW 1.4**, short of 2 and therefore not an edge anyone should size on. The short lenses are INVERTED: unusual-down -0.44pp, weak -0.47pp — the names they flagged to sell went on to beat SPY, so in this sample they read as contrarian LONG signals rather than shorts. breakout (-0.33pp) sits at or below the qualified baseline of 0.06pp — selecting on it costs you money. On features, `distEma21Atr` (IC -0.0165, t -1.8; halves -0.0001/-0.0328, half-t -0.0/-2.3), `ddFrom20dHigh` (IC -0.0200, t -2.2; halves -0.0132/-0.0267, half-t -1.1/-1.9), `bbWidthPctl120` (IC 0.0035, t 0.7; halves 0.0010/0.0059, half-t 0.1/0.9), `rsi14` (IC -0.0147, t -1.6; halves -0.0003/-0.0289, half-t -0.0/-2.0) keep the SAME SIGN in both halves, and of those `distEma21Atr`, `ddFrom20dHigh`, `bbWidthPctl120`, `rsi14` also hold that sign on BOTH venues; **none reaches |t| ≥ 2.5 in both halves**, and 10 of the fourteen (ret5, ret20, ret60, rsSpy20, rsSpy60, rvol, ema50Slope20, distTo52wHigh, upDays10, volTrend5) change IC SIGN between the halves — the signature of a feature fitting the regime rather than the market. The composite settles it: picked in-sample the top decile returns nothing, but selected honestly on the first half and scored on the second it returns -0.30pp (hit 38.3%, t_NW -0.8), beating SPY on only 44.3% of dates — an in-sample edge that does not survive one honest split is not an edge. **The strongest honest ranking available today** is therefore not a ranking of these fourteen features at all: it is (1) rs-leader as a WATCHLIST, not a sized call, (2) `ddFrom20dHigh` (IC -0.0200) — the only feature that holds one IC sign across both halves AND both venues while reaching |t| ≥ 2 overall — as a mild tiebreak, and (3) an explicit acknowledgement that the current board showing 0 sized calls is the correct output of this data rather than a bug in the scoring. Rebuilding the score on top of these features would be fitting noise; what the engine needs first is either a longer tape (300 bars is 9.2 months of signal dates and one regime) or features that are not all measuring the same trailing price move.

**Multiple-comparison and honesty caveats.** 14 features — of which `ret20`/`rsSpy20` and `ret60`/`rsSpy60` are rank-identical, so 12 independent — times (whole sample + 2 halves + 2 regimes + 2 exchanges), plus 8 lenses times the same splits, is ~130 comparisons; at α = 0.05 roughly 6 "significant" results are expected from pure noise, which is why nothing above is claimed on a single naive t. The forward windows overlap (5 sessions, stepped daily) and the cross-section is correlated within each date, so the naive t is inflated by something like √5 before the cross-sectional correlation is even counted — that is why t_NW (Newey–West, 5 lags, on the per-date mean series) is the number every claim leans on and why a naive t of 6.4 becomes 1.6. The sample is 193 signal dates spanning 9.2 months with SPY above its 50-EMA on 155 of them: this is one regime, and nothing here has been tested through a drawdown. There are no transaction costs, no borrow costs on the short lenses, no slippage on the next-day open and no bid-ask — the LSE column in particular (mean 1.43pp baseline, a full 1.34pp above US) is measured on closing prices of names whose real spreads are not in this data. Finally the universe is TODAY's index membership, so every name in it survived to today and nothing that was delisted, taken over or demoted during the window appears at all; the baseline excess of 0.34pp is an upper bound for that reason alone.


---

## Horizon comparison: 5 vs 10 vs 20 sessions

| | 5 | 10 | 20 |
|---|---:|---:|---:|
| signal dates | 193 | 188 | 178 |
| qualified baseline mean | 0.06pp | 0.10pp | 0.32pp |
| rs-leader mean / edge / hit | 0.71 / 0.65 / 46.4% | 1.10 / 1.00 / 46.5% | 2.55 / 2.22 / 49.7% |
| rs-leader naive t → t_NW | 5.9 → **1.4** | 6.4 → **1.6** | 10.2 → **1.6** |
| rs-leader mean MAE | −6.4% | −8.6% | −11.3% |
| best feature by \|IC t\| | rvol 0.0105 (t 3.0) | bbWidthPctl120 0.0153 (t 3.0) | bbWidthPctl120 0.0264 (t **5.5**) |
| bbWidthPctl120 IC halves | — (outside top 5) | 0.0112 / 0.0194 | 0.0221 / 0.0306 |
| features flipping IC sign between halves | 9 of 14 | 10 of 14 | 10 of 14 |
| honest (h1-selected, h2-scored) composite D10 | −0.30pp, 38.3%, t_NW −0.8 | −0.35pp, 40.0%, t_NW −0.6 | **+0.28pp**, 42.9%, t_NW **0.4** | 
| …dates the top decile beat SPY | 43/97 (44.3%) | 39/94 (41.5%) | 46/89 (51.7%) |

**Does rs-leader strengthen at 20 sessions?** In pp, yes and almost exactly proportionally: 0.71 → 1.10 → 2.55pp, an edge over the qualified baseline of 0.65 → 1.00 → 2.22pp, with the hit rate climbing 46.4% → 46.5% → 49.7%. In *evidence*, no: the naive t nearly doubles (5.9 → 10.2) while **t_NW is pinned at 1.4–1.6 at every horizon**, because lengthening the window lengthens the overlap by exactly as much as it raises the mean. A statistic that will not move when the effect trebles is telling you the 178 dates contain one regime, not 178 independent experiments. The cost side also scales: mean MAE deepens from −6.4% to −11.3%, so a 20-session rs-leader hold is a 2.2pp edge bought with an 11% average drawdown — a worse edge-per-unit-pain than the 10-session version, not a better one.

**Do the momentum-family sign flips persist?** Yes, and they get no better with the horizon: 10 of 14 features change IC sign between the halves at 20 sessions, the same count as at 10 and one more than at 5. `ret60`/`rsSpy60` flip +0.0207 → −0.0651 at 20 sessions (they flipped +0.0226 → −0.0441 at 10); `ret5`, `rsi14`, `distEma21Atr`, `ema50Slope20`, `upDays10`, `rvol` and `volTrend5` all flip at 20 too. `ret20`/`rsSpy20` are the awkward case — stable-negative at 10 sessions (−0.0015/−0.0106) and stable-*positive* at 20 (+0.0091/+0.0072), which is instability across the horizon rather than within it, and is why they are not a tiebreak candidate at any horizon. The two exceptions hold everywhere: **`bbWidthPctl120` (compression) keeps a positive IC in both halves at every horizon and strengthens monotonically with it — IC t 3.0 at 10 sessions, 5.5 at 20, D10−D1 +0.58pp → +1.00pp — and `ddFrom20dHigh` keeps a negative IC (buy the name nearer its 20-day high) at all three.** Those are the only two signals in the study whose sign is not an artefact of the window chosen.

**Net.** Twenty sessions is the best of the three horizons and still not good enough: it is the only one whose honestly-selected composite is positive out of sample (+0.28pp), but at t_NW 0.4 and 51.7% of dates that is a coin toss with extra steps. The horizon sweep does not rescue the feature set; it just confirms that the one real thing in it is compression, and that everything shaped like trailing return is fitting the regime.

## Appendix: free post-earnings data availability (probe only — no lane built)

- **`api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD`** — HTTP **200**, no key, no cookie, `User-Agent: Mozilla/5.0` + `Accept: application/json` is enough. 43 sessions (2026-06-24 → 2026-08-21) fetched clean at ~0.25 s spacing: **4,361 rows, ~101/day, 4,331 distinct symbols, 1,410 of them in the discovery seed.** Fields per row: `symbol`, `name`, `eps` (ACTUAL, `"$24.89"` / `"($8.75)"` for negatives), `epsForecast` (consensus), `surprise` (percent, as a string), `marketCap`, `fiscalQuarterEnding`, `noOfEsts`, `time`.
- **`time` is the trap.** On a PAST date every row reads `time-not-supplied`; on a FUTURE date (2026-09-24) the same field carries `time-pre-market` / `time-after-hours`, and the rows instead carry `lastYearRptDt` / `lastYearEPS` with no `eps`/`surprise`. So a lane must snapshot the forward calendar to learn the session timing and re-read the same date afterwards to learn the outcome; neither call alone gives both.
- **Finnhub `/calendar/earnings` without a key** — HTTP **401**, `{"error":"Please use an API key."}`. No anonymous tier.

### One check, using the bars already fetched

Entry = the open of the session after the earnings date, exit = close 10 or 20 sessions later, excess vs SPY over the same calendar window, hit ≥ +1pp, t_NW on the per-date means.

| cohort | n | 10-sess mean | hit | t_NW | 20-sess mean | hit | t_NW |
|---|---:|---:|---:|---:|---:|---:|---:|
| all earnings name-dates | 1,410 | −1.02pp | 34.5% | −2.59 | −1.93pp | 31.4% | −4.02 |
| positive EPS surprise | 1,043 | −1.24pp | 34.0% | −3.30 | −2.42pp | 30.7% | −4.20 |
| gap-up ≥ 3% (any surprise) | 253 | −1.23pp | 34.4% | −3.23 | −2.83pp | 30.0% | −6.07 |
| **positive surprise AND gap-up ≥ 3%** | **212** | **−1.47pp** | **34.0%** | **−3.34** | **−3.43pp** | **28.8%** | **−6.79** |

The drift runs the WRONG WAY: buying a positive-surprise gap-up at the next open lost 1.5pp to SPY over 10 sessions and 3.4pp over 20, and the more the filter tightened the worse it got — the only monotone, sign-stable, t_NW-significant relationship anywhere in this study. Read as a *fade* it is a candidate event lane; read as the obvious long it is the opposite of an edge. Caveats before anyone acts: n = 212 over 24 dates in ONE earnings season (late Jun – Aug 2026); the whole earnings cohort underperformed (−1.02pp) so most of this is "names that just reported lagged", not the gap; only seed names are covered (1,410 of 4,331 symbols); `time` is unavailable historically so a pre-market reporter's gap is already spent by the entry open used here; and there is no borrow, no cost and no slippage in the number.
