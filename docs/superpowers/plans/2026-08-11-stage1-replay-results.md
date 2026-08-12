# Stage 1 replay: acceptance evidence, 14 Jul – 11 Aug 2026

**Ship gate for `docs/superpowers/plans/2026-08-11-stage1-seeing-and-board.md` (Task 7).**
Produced 2026-08-12 by `scripts/replay-window.ts`. Nothing here is tuned: the engine was run
as committed, the numbers are reported as they came out, and where a criterion fails it is
written up as a failure.

- **New run:** commit `69ced4c` (Stage 1 complete).
- **Baseline run:** commit `730521d` (the last pre-Stage-1 commit), in a `git worktree`.
- **Verdict in one line:** criteria 1, 3 and 4 pass clearly; criterion 2 (GLW) **fails on its
  last clause** — the dip lane never constructed a GLW call, for a defensible reason; criterion 5
  shows a small *negative* drift on trades that is statistically indistinguishable from noise
  (t = −0.32) on a 21-day window. **The owner decides.**

---

## 1. How the replay works

`scripts/replay-window.ts` drives the **real daily brain** — `gradeOutstanding()` then
`buildBoard()` — once per trading day, against an in-memory `AppStore` whose blobs **carry
across days**. The roster, calibration buckets, factor-IC weights, risk ladder, prediction
ledger and Brier trail therefore all evolve over the month exactly as they would in production.

This is deliberately *not* `scripts/engine-replay.ts`, which drives `composeCall` over a fixed
50-name universe on 5 Mondays. That harness cannot see the sleeve, the dip lane, the roster, the
near-miss rows or the sizing tiers, so it cannot measure this stage at all.

**Point-in-time discipline.** On replayed date D the engine may only see bars that closed
**strictly before D** — the same thing the live 05:20 run sees, because D's bar does not exist
yet. `gradePrediction` then bases the outcome on D's *open*, unchanged.

**Candles.** One Yahoo `5y` fetch per symbol, cached to disk under
`…/scratchpad/replay-candles/`, throttled to 2 concurrent with a 120 ms gap and one 30 s retry
on a 429. `deps.candles` serves the last 252 bars of the slice (the 1y window production reads);
`deps.candles5y` serves the whole slice, so **seasonality really runs**. A symbol Yahoo refuses
is recorded as missing and never synthesised — **0 symbols were missing in either run.**

*Integrity check:* the cached 5y series was compared against a fresh `1y` fetch for GLW, NVDA,
LCID, RR.L and SPY — **251–252 overlapping bars each, 0 mismatches, worst deviation 0.00%.**
Split adjustment is consistent across ranges, so the slices are sound.

**Universe.** 130 `DEFAULT_CORE_SLEEVE` names (mirrored literally in the script, guarded by a
unit test against drift) + the 22 window tickers the owner asked for (NRGV, PATH, JACK, ETH-USD,
MS, AVEX, MSTR, 3CON.L, SANA, RR.L, IRWD, MX, RR, GS, GOOGL, XOM, UROY, TSLA, KTOS, EFOR, VZLA,
GLW) = 146 distinct, plus SPY/QQQ and the 8 world-tape series = 154 warmed. Anything else the
engine asked for (sector ETFs, theme members) was served lazily from the same cache.

**Window.** 21 US trading days, derived from SPY's own bars: 2026-07-14 … 2026-08-11.

**Exact commands.**

```bash
# new engine (from the repo root, commit 69ced4c)
npx vite-node scripts/replay-window.ts -- --from 2026-07-14 --to 2026-08-11 \
  --watch GLW,TSLA,NVDA --out .../scratchpad/replay-new.json

# baseline — a worktree, NOT a LEGACY_BOARD branch in production engine code
git worktree add --detach .../scratchpad/baseline-730521d 730521d
ln -s /Users/inayat/Projects/thestreetsignal/node_modules .../scratchpad/baseline-730521d/node_modules
cp scripts/replay-window.ts .../scratchpad/baseline-730521d/scripts/replay-window.ts
cd .../scratchpad/baseline-730521d
npx vite-node scripts/replay-window.ts -- --baseline --from 2026-07-14 --to 2026-08-11 \
  --watch GLW,TSLA,NVDA --out .../scratchpad/replay-baseline.json
cd - && git worktree remove .../scratchpad/baseline-730521d
```

The same script runs in both trees. It guards its two Stage-1-only imports (`dipLane`,
`coreSleeve`) with an on-disk existence check, so in the pre-Stage-1 worktree the dip
diagnostics simply report "absent" — which *is* the baseline.

**Runtime.** ~75 s to warm 154 symbols from Yahoo (once; both runs share the cache), then
**0.0–0.7 s per replayed day**. A full 21-day run is under 5 s on a warm cache.

---

## 2. Approximations — read this before reading the numbers

Every one of these applies **identically to both runs** unless flagged otherwise.

| # | Approximation | Consequence |
|---|---|---|
| 1 | **Screens are synthesised.** Yahoo's predefined screeners have no point-in-time form, so `day_gainers` / `day_losers` / `most_actives` are recomputed as the top-25 gainers, top-25 losers and top-25 $-volume names **within the replay universe**. | The real screens scan the whole US market and would rarely surface a megacap. Restricting them to a universe that is 89% famous names hands the **baseline** discovery it would never have had in production. **This biases in the baseline's favour**, which makes the new engine's margins conservative. |
| 2 | `small_cap_gainers` cannot be synthesised (no point-in-time caps) and is **absent from both runs**. | Fewer micro-cap discovery names than production, both sides. |
| 3 | **`day_losers` is withheld in `--baseline`.** | Mirrors pre-Stage-1 `defaultDeps` exactly. This screen lives in `defaultDeps`, not in `buildBoard`, so the harness has to withhold it itself. |
| 4 | **No market caps** (`capUsdM → null`). | Every name is cap-unknown: cohortless calibration buckets, no small-cap stop widening, and the dip lane's `> $10B` quality door is **shut** — sleeve membership is the only way into the lane. Understates the new engine's dip coverage. |
| 5 | **No earnings calendar** (`earningsSyms → ∅`). | No `earningsRisk` shadowing, no event radar, and the near-miss earnings exclusion never fires. Both runs publish calls into prints they would have refused live. |
| 6 | **Empty `levMap`** (per brief). | **Every short is unroutable → shadow.** The short side of the live board is observation-only in *both* runs. All 42 near-miss rows in the new run are shorts. See the caveat under criterion 1. |
| 7 | **No LLM / news / social / insiders / 13F / holdings.** `dipNews` always returns `unclear`. | The dip lane is never stood down and never corroborated; the news, social, channels, insiders, smartMoney and catalyst factors cast nothing. Price-only, both runs. |
| 8 | `worldReads` are one session stale (D−1 vs D−2, not D's live Asian session). | Small, symmetric conviction-nudge drift. |
| 9 | Config: `watchlist: []`, `coreSleeve: []`, `capital: 5000`, `riskAppetite: 'aggressive'`. | Matches the owner's stated appetite. `moderate` would narrow both runs equally (dead zone 25 vs 20). Re-runnable with `--appetite moderate`. |

**What this evidence therefore is:** a like-for-like measurement of what the Stage-1 *board
machinery* does to the same price tape. **What it is not:** a forecast of live P&L, a test of the
LLM lanes, or a reproduction of the real-world blank-board frequency the owner experienced.

---

## 3. Criterion 1 — blank actionable boards

| | baseline (`730521d`) | new (`69ced4c`) |
|---|---|---|
| Days with **zero sized trades** | **1 / 21** (2026-07-31) | **0 / 21** ✅ |
| Days with a **fully blank board** (nothing named at all) | 0 / 21 | 0 / 21 |
| Days **named but no trades** | 1 | 0 |
| **Blank sides** (of 42 side-days) | **21** — the short side, every single day | **0** |
| Tradeless sides (of 42) | 22 | 21 |

**Target (0 zero-trade days after) is met.**

The one baseline failure is instructive. On **2026-07-31** (red regime) the baseline board was:

```
EFOR/C/watch  LCID/C/watch  UROY/C/watch  ADBE/C/watch  SLB/C/watch     → 0 trades
```

Five real setups, all graded C, all published at zero size — precisely the "the engine has no
opinion" morning Stage 1 exists to kill. The new engine on the same tape:

```
ARM/B/full(dip)  RBLX/C/half  EFOR/C/half   + 6 watch rows + 2 near-miss shorts  → 3 trades
```

and those three resolved **ARM +5.3% HIT, EFOR +14.5% HIT, RBLX −6.6% miss** at 5 sessions.

**Caveat, stated plainly.** The blank-*sides* improvement (21 → 0) is almost entirely the
near-miss rows filling a short side that is structurally empty *because* `levMap` is empty —
every short is unroutable and therefore shadowed. With a real `levMap` the short side would carry
live rows of its own and near misses would fire far less often. The honest reading of "21 → 0" is
**"the reader is never shown a nameless side"**, not "the engine found 21 new short trades".

Also note the baseline only failed once here because the synthesised screens fed it a
famous-name universe (approximation #1). Its real-world blank-board rate is not measured by this
harness.

---

## 4. Criterion 2 — GLW · **MIXED, one clause FAILS**

GLW's actual tape over the window: **255.7 (29 Jun) → 124.1 (29 Jul) → 159.2 (11 Aug)** — a −51%
collapse, then a partial recovery. This was not a post-earnings dip that stabilised; it was a
sustained decline.

| Sub-question | Answer |
|---|---|
| **Candidate?** | **New: yes, 21/21 days.** Baseline: **no for the first 6 trading days** — GLW did not enter the candidate pool until 2026-07-22. |
| First door | New: `screener:losers` on **2026-07-14**, day one. Baseline: `screener:gainers` on 2026-07-22, after the fall had already run 30%. |
| **Dip classified?** | **Triggered on 21/21 days.** `holding` was **false on 21/21 days**. Depth ran 28.4% → 50.7% (29 Jul) → 11.7% (10 Aug). |
| **Dip call constructed?** | **Never (0/21).** `dipCall` is only reached when a dip is triggered *and* holding, and GLW never held. |
| **Reached the reader's board?** | **Never — in either run.** In the new run GLW published an unroutable composite SHORT **shadow** on 2026-07-17 and 2026-08-03; in the baseline on 2026-07-22 and 2026-08-06. |

Per-day candidacy trace (new run, `--watch GLW`):

| date | new doors | new evaluated | baseline doors | baseline evaluated |
|---|---|---|---|---|
| 07-14 | screener:losers | ✅ | — | ❌ |
| 07-15 | roster | ✅ | — | ❌ |
| 07-16 | losers, sleeve-top40, roster | ✅ | — | ❌ |
| 07-17 | losers, sleeve-top40, roster | ✅ | — | ❌ |
| 07-20 | roster | ✅ | — | ❌ |
| 07-21 | roster | ✅ | — | ❌ |
| 07-22 | gainers, roster | ✅ | gainers | ✅ |
| 07-23 → 08-11 | losers/gainers/sleeve-top40/roster | ✅ (all) | roster (mostly) | ✅ (all) |

**Read.** The *seeing* half of the criterion passes convincingly and is exactly what Task 2's
`day_losers` screen was for: **six trading days of earlier candidacy**, at the top of the fall
rather than after it. The *dip-call* half fails, and the failure looks like the lane working
correctly rather than the lane being broken — GLW was a falling knife, the `holding` guard
(paid reclaim / knife guard) refused it every day, and buying it on any of those days would have
lost money. The spec's motivating sentence ("GLW dropped 15% and the movers scanner never saw
it") is satisfied in the seeing sense; the implied "…and the dip lane would have bought it" is
**not** satisfied, and should not be claimed.

**The lane is not dead** — it fired 10 times on other names in the same window:

| date | dip rows that reached the board |
|---|---|
| 07-17 | IBM B full |
| 07-31 | ARM B full · RBLX C half |
| 08-04 | RBLX B full |
| 08-05 | RBLX B full · AZN.L B full |
| 08-06 | AZN.L C half |
| 08-07 | DKNG B full |
| 08-10 | DDOG B full (1.25%) · AZN.L watch |

**Open question for the owner:** GLW never reaching *any* reader-facing row for a month, while
falling 51% and being classified as a triggered dip every day, is arguably its own gap. The
engine's only opinion on it was a short it could not route, so it was shadowed. That is Stage 2
territory (a "watching this fall" observation row), not a Stage 1 threshold to tune.

---

## 5. Criterion 3 — sleeve names reaching a board

| | baseline | new |
|---|---|---|
| Distinct **sleeve** names on any board | **19** | **62** |
| …as a sized trade | 15 | 17 |
| …as a watch row | 7 | 40 |
| …as a near miss | 0 | 26 |
| Distinct names of **any** kind on any board | 29 | 78 |
| Candidates evaluated per day (median) | ~120 | ~145 |

Baseline: `AAL.L AAOI ADBE BA CRWD DDOG DOW GE HOOD LCID MSTR NET OXY PLTR PYPL RBLX RR.L SLB ZS`

New adds 45 sleeve names the baseline never showed, including every megacap the owner complained
about not seeing: `AAPL AMD ARM AXP AZN.L BLK BP.L CAT COP CVX GS IBM JNJ LLY LMT META MMM MS NKE
ORCL PANW PEP RIVN RKLB SHOP SMCI SNOW SOFI TMO TSLA UNH VOD.L XOM …`
(baseline-only: `AAL.L`, `BA` — two names the new roster churn dropped).

**Passes.** This is the clearest win in the whole exercise: **3.3× the sleeve coverage, 2.7× the
distinct names.**

---

## 6. Criterion 4 — grade distribution and sizing tiers

| | baseline | new |
|---|---|---|
| Trade rows | 59 | 63 |
| grade **A** | **0** | **0** |
| grade **B** | 59 (**100%**) | 52 (**83%**) |
| grade **C** | 0 | **11 (17%)** |
| `riskPct` values seen | {1, 1.25} | {**0.5**, 1, 1.25} |
| **C-as-half-trades** | 0 (impossible pre-Stage-1) | **11** |
| A/B-without-contract half-trades | 0 | **0** — that tier never fired |
| Watch rows | 13 (2 B, 11 C) | 125 (84 B, 41 C) |
| Near-miss rows | 0 | 42 (all stamped C, all zero size) |
| Ledger rows (incl. shadows) | 148 (76 shadow) | 279 (91 shadow) |

**Passes as specified.** The half-size C tier is doing real work: 11 of 63 trades exist only
because of it, and on 2026-07-31 two of them are the difference between a blank board and three
trades.

Two honest observations:
- **No A grade was ever produced by either engine** across 21 days and 122 trade rows. The
  calibration seed's top band was never reached on this window. Not a Stage-1 regression (the
  baseline has the same zero), but worth knowing before "A" is used anywhere in copy.
- The **A/B-without-contract** half-size tier never fired once. Either it is rare, or the
  contract is easier to clear than assumed. Unexercised code is unmeasured code.

---

## 7. Criterion 5 — win5 / avg5 · **small negative drift, inside noise**

5-session outcomes are gradable through **2026-08-04** and 10-session through **2026-07-28**
(the cache's last bar is 2026-08-11), so the last few days of the window contribute rows but no
grades. `hit` = not stopped **and** SPY-relative excess ≥ the repo threshold.

**Sized trades only**

| | n | graded 5d | win5 | avg5 | stop5 | graded 10d | win10 | avg10 |
|---|---|---|---|---|---|---|---|---|
| baseline | 59 | 45 | **55.6%** (25/45) | **+3.17%** | 18% | 33 | 60.6% | +2.58% |
| new | 63 | 48 | **52.1%** (25/48) | **+2.48%** | 21% | 33 | 54.5% | +1.95% |

**Difference: −3.5 pp win5, −0.69 pp avg5.** Significance on this window:
excess-return sd ≈ 10.3 (baseline) / 10.7 (new) → **t = −0.32** for avg5; **z = −0.34** for win5.
Both are indistinguishable from zero. With n ≈ 46 per arm this test could only detect a swing of
roughly ±4.3 pp of average excess — the observed 0.69 pp is a twentieth of that. **This window
cannot tell the two engines apart on outcomes, in either direction.**

**Where the difference actually lives** (the two boards overlap heavily):

| set | n | graded 5d | win5 | avg5 |
|---|---|---|---|---|
| **shared** trade rows (same date+sym+side) | 46 | 37 | 59.5% | **+4.17%** |
| **new-only** trade rows | 17 | 11 | 27.3% | **−3.19%** |
| **baseline-only** trade rows | 13 | 8 | 37.5% | **−1.44%** |

Both engines' *marginal* picks underperform their shared core, by similar amounts. That reads as
"the 3rd/4th-best idea of the day is weaker than the 1st/2nd", not as a Stage-1 defect: the new
engine simply has 4 more marginal rows than the baseline, and marginal rows drag the mean.

**By Stage-1 tier** (all tiny n — colour, not proof):

| tier | n | graded 5d | win5 | avg5 |
|---|---|---|---|---|
| B full trades | 52 | 42 | 50% | +1.75% |
| **C half trades** (new tier) | 11 | 6 | **67%** | **+7.58%** |
| dip-lane trades | 9 | 4 | 25% | −1.00% |
| composite trades | 54 | 44 | 55% | +2.80% |

**Near-miss rows behave exactly as an honest label should:** 42 rows, win5 **48.4%**,
avg5 **−0.30%** — measurably *worse* than the trades they sit beside. They are not disguised
trades, and the board is right to give them no size.

Watch rows dilute the mean as designed: trades + watch, new = 47.2% win5, +2.64% avg5 over 142
graded rows.

---

## 8. Per-day table

`T/W/NM` = sized trades / watch rows / near-miss rows.

| date | regime | base T/W/NM | new T/W/NM | baseline trades | new trades |
|---|---|---|---|---|---|
| 07-14 | amber | 3/0/0 | 3/6/2 | JACK·B GE·B RR.L·B | SANA·B IRWD·B JACK·B |
| 07-15 | amber | 3/0/0 | 3/6/2 | ZS·B JACK·B HOOD·B | ZS·B SANA·B JACK·B |
| 07-16 | amber | 3/0/0 | 3/6/2 | RBLX·B HOOD·B ETH-USD·B | RBLX·B SANA·B HOOD·B |
| 07-17 | amber | 3/0/0 | 3/6/2 | LCID·B JACK·B ETH-USD·B | **IBM·B (dip)** LCID·B AFRM·B |
| 07-20 | amber | 3/0/0 | 3/6/2 | LCID·B ETH-USD·B JACK·B | LCID·B ETH-USD·B JACK·B |
| 07-21 | amber | 3/0/0 | 3/6/2 | LCID·B ADBE·B ZS·B | LCID·B ADBE·B ZS·B |
| 07-22 | amber | 3/0/0 | 3/6/2 | DDOG·B LCID·B ZS·B | DDOG·B LCID·B ZS·B |
| 07-23 | amber | 3/0/0 | 3/6/2 | JACK·B LCID·B NET·B | JACK·B LCID·B NET·B |
| 07-24 | amber | 3/0/0 | 3/5/2 | NET·B LCID·B DOW·B | LMT·B NET·B LCID·B |
| 07-27 | amber | 3/0/0 | 3/6/2 | NET·B LCID·B ANET·B | NET·B LCID·B ANET·B |
| 07-28 | amber | 3/1/0 | 3/6/2 | ETH-USD·B DDOG·B JACK·B | ETH-USD·B DDOG·B JACK·B |
| 07-29 | amber | 3/0/0 | 3/6/2 | LCID·B PYPL·B NET·B | LCID·B PYPL·B NET·B |
| 07-30 | amber | 3/0/0 | 3/6/2 | EFOR·B LCID·B ADBE·B | EFOR·B LCID·B ADBE·B |
| **07-31** | **red** | **0/5/0** | **3/6/2** | **— (blank)** | **ARM·B (dip) RBLX·C EFOR·C** |
| 08-03 | amber | 3/1/0 | 3/6/2 | UROY·B EFOR·B IRWD·B | UROY·C EFOR·C IRWD·C |
| 08-04 | amber | 3/0/0 | 3/6/2 | EFOR·B UROY·B OXY·B | RBLX·B (dip) EFOR·B UROY·C |
| 08-05 | amber | 3/0/0 | 3/6/2 | PLTR·B EFOR·B OXY·B | PLTR·B RBLX·B (dip) AZN.L·B (dip) |
| 08-06 | amber | 3/0/0 | 3/6/2 | UROY·B EFOR·B HPE·B | UROY·C EFOR·C AZN.L·C (dip) |
| 08-07 | amber | 3/0/0 | 3/6/2 | UROY·B EFOR·B AAOI·B | DKNG·B (dip) UROY·C EFOR·C |
| 08-10 | amber | 3/0/0 | 3/6/2 | KTOS·B EFOR·B MSTR·B | DDOG·B (dip) EFOR·B MSTR·B |
| 08-11 | green | 2/6/0 | 3/6/2 | KTOS·B EFOR·B | VOD.L·B KTOS·B EFOR·B |

The roster settled at its 80-name cap by 2026-07-16 in the new run and 2026-07-31 in the
baseline. Regime: amber on 19 days, red on 07-31, green on 08-11 — identical in both runs.

---

## 9. What this evidence does and does not show

**It does show:**

1. On this tape the new engine **never publishes a tradeless board** (0/21 vs 1/21), and never
   publishes a nameless side (0/42 vs 21/42).
2. **Seeing improved a lot and measurably.** 19 → 62 distinct sleeve names reaching a board;
   29 → 78 distinct names overall; ~120 → ~145 candidates evaluated per day. GLW became a
   candidate **six trading days earlier** than it would have, entirely because of the
   `day_losers` screen.
3. The **half-size C tier is load-bearing**, not cosmetic: 11 of 63 trades, and the whole of the
   07-31 rescue.
4. The **dip lane constructs real calls** (10 board rows over 8 days) and its `holding` guard
   correctly refused a name that fell 51%.
5. **Near-miss rows are honestly labelled** — they underperform the trades beside them
   (−0.30% vs +2.48% avg5), which is what a zero-size observation row should look like.
6. `npx tsc -b` clean; **906/906 tests pass** (890 before + 16 new harness tests).

**It does not show:**

1. **Any edge, or any loss of edge.** 21 days, ~46 gradable trades per arm, t = −0.32. The −3.5 pp
   win5 / −0.69 pp avg5 drift is noise at this sample size and must not be reported as either a
   regression or a win. Ask again after a real quarter of live 10d grades.
2. **The real blank-board rate.** The synthesised screens gave the baseline a famous-name
   universe it would never have had in production (approximation #1), so the baseline looks far
   healthier here than the owner's lived experience.
3. **Anything about the LLM lanes.** `dipNews`, `newsCatalysts`, social, insiders, 13F and
   holdings were all empty. The dip lane in particular was never once stood down by news, which
   is its main safety valve.
4. **Short-side behaviour.** With an empty `levMap` every short is unroutable and shadowed in
   both runs, so the entire short side of the live board is observation-only, and all 42
   near-miss rows are shorts. A real `levMap` would change this picture materially.
5. **Small-cap / cohort behaviour.** No market caps means every call went through the cohortless
   calibration path and no small-cap stop widening ever fired.
6. **Earnings discipline.** With no calendar, `earningsRisk` never shadowed anything, so both
   boards carried calls into prints that production would have refused.

**Failures, restated so they cannot be skimmed past:**

- **Criterion 2's "dip call constructed?" is a NO for GLW — 0 of 21 days.** The reason is
  defensible (GLW never met the `holding` test; it was still falling) but the criterion as
  written is not met, and GLW never reached a reader-facing row in either engine.
- **Criterion 5 shows the new engine's trades slightly behind the baseline's** (52.1% vs 55.6%
  win5; +2.48% vs +3.17% avg5). Inside noise, but it is a minus sign and it is reported as one.
- **No A grade was produced by either engine** in 21 days.
- **The A/B-without-contract half-size tier never executed once** and is therefore unmeasured.

**Explicitly not done:** no engine threshold was adjusted, no gate was relaxed, and no run was
repeated to get a better number. Both runs are the first and only runs of their commits over this
window.

---

## 10. Reproducing

Raw output (per-day boards, ledgers, dip diagnostics, candidacy traces, graded outcomes) lives in
`replay-new.json` and `replay-baseline.json` under the session scratch directory. Both are
regenerable from the commands in §1; the candle cache makes a re-run take seconds.

The harness's pure helpers (`sliceBefore`, `tradingDays`, `synthScreens`, `sparkClosesFrom`,
`summariseBoard`, `doorsFor`, and the `SLEEVE_MIRROR` drift guard) are covered by
`scripts/replay-window.test.ts` — 16 tests, part of `npm test`.

---

## 11. 2026-08-12 holding-rule re-run

The owner ratified one change on the back of §4: **the dip lane's volume leg becomes
turn-scoped.** Holding's volume condition is now satisfied if volume ≥ 1.5× the 20-session
average printed on **any of the last 5 sessions** (today included), instead of on today alone.
The other two legs are untouched and still measured on today (no new 5-session closing low; close
over the 50-EMA **or** ≥3% above the dip-window low). The reasoning is in `dipLane.ts`: the
session that pays for a turn is the one that reverses it, and the quiet sessions after it are the
base forming, not the confirmation expiring.

Two runs were needed to keep the attribution honest, because the closing wave also carried the
final review's board fixes:

```bash
# both from the repo root; the SAME candle cache as §1, so the tape is identical
REPLAY_CACHE_DIR=…/scratchpad/replay-candles npx vite-node scripts/replay-window.ts -- \
  --from 2026-07-14 --to 2026-08-11 --watch GLW,TSLA,NVDA --out …/scratchpad/replay-partB.json    # d6f63a2, board fixes only
REPLAY_CACHE_DIR=…/scratchpad/replay-candles npx vite-node scripts/replay-window.ts -- \
  --from 2026-07-14 --to 2026-08-11 --watch GLW,TSLA,NVDA --out …/scratchpad/replay-turnvol.json  # + the turn-scoped rule
```

(The cache default is now the repo-relative `./.replay-cache`; `REPLAY_CACHE_DIR` points both runs
at the §1 cache so nothing was re-fetched and no bar differs. The baseline was **not** re-run —
it cannot change.)

### 11.1 GLW — the acceptance question

**Yes. GLW's dip call constructs, and it reaches the reader's board as a full-size trade.**

| date | close | holding | dip call | entry | stop | target | R:R | 5-session outcome |
|---|---|---|---|---|---|---|---|---|
| 2026-07-31 | 135.22 | ✅ (3.6× volume **2 sessions ago**) | **built** | 135.22 | 114.50 | 166.00 | 1.49 | **HIT, +11.4% vs SPY** |
| 2026-08-03 | 138.25 | ✅ (3.6×, 3 sessions ago) | **built** | 138.25 | 114.50 | 166.53 | 1.19 | **HIT, +13.8% vs SPY** |
| 2026-08-04 | 146.64 | ✅ (3.6×, 4 sessions ago) | declined | — | — | — | 0.63 | — |
| 2026-08-05 | 159.89 | ✅ (1.8×, 4 sessions ago) | declined | — | — | — | 0.18 | — |
| 2026-08-06 → 08-11 | 156.70 → 165.68 | ❌ (best 1.4× in 5) | — | — | — | — | — | — |

Both rows published **grade B, 1% risk, catalyst `dip`**, and on 07-31 — the red-regime day that
was the baseline's only blank board — GLW was the **first trade on the board**. On 08-03 the
composite also published its opposing GLW short, as a shadow; F3's new condition was satisfied on
both days (the dip long published as a *sized* row, so it is entitled to demote). Whether the
demotion itself fired cannot be read off this harness — with an empty `levMap` (approximation #6)
every short is unroutable and shadows anyway.

The two declines matter as much as the two builds: on 08-04 and 08-05 the dip was still *holding*,
but price had run so far off the 114.50 low that the half-retrace target no longer paid for the
stop — R:R 0.63 and 0.18 against a 1:1 floor. **The lane refused to chase its own winner.** Then
the 3.6× session aged out of the 5-day window and holding went false on its own. So the rule did
not simply switch GLW on for the month; it opened a **two-day window at the turn** and closed it.

Honest caveats: n = 2, both graded at 5 sessions only (10-session grades are not yet reachable for
either), and 07-31/08-03 are consecutive reads of the same recovery — one event, not two
independent successes. GLW's *earlier* collapse (14 Jul → 30 Jul, −51%) is still refused on all
13 days, by the knife guard and the reclaim leg, which is the outcome §4 said was correct.

### 11.2 What the change did to the window — three-way

Part B (the board fixes) is measured on its own first, so nothing below is misattributed.

| | §3-§7 run (`69ced4c`) | + board fixes (`d6f63a2`) | + turn-scoped volume |
|---|---|---|---|
| Sized trades | 63 | **63** | **63** |
| Watch rows | 125 | 133 | 134 |
| Near-miss rows | 42 | **26** | 26 |
| Short **observations** (F2, "no ISA route") | 0 | **8** | 8 |
| Ledger rows (incl. shadows) | 279 (91 shadow) | 287 (91) | 288 (91) |
| Grade A / B / C on trades | 0 / 52 / 11 | 0 / 52 / 11 | 0 / **55** / **8** |
| `riskPct` values seen | {0.5, 1, 1.25} | {0.5, 1, 1.25} | {0.5, **0.625**, 1, 1.25} |
| Zero-trade days | 0 / 21 | 0 / 21 | 0 / 21 |
| Blank sides | 0 / 42 | 0 / 42 | 0 / 42 |
| Dip **holding**-days (all names) | 48 | 48 | **182** |
| `dipCall` constructions | 15 | 15 | **68** |
| Dip rows on the board | 10 (9 sized) | 10 (9) | **45 (32 sized)** |
| Trades win5 / avg5 | 52.1% / +2.48% | 52.1% / +2.48% | **54.2% / +1.85%** |
| Trades win10 / avg10 | 54.5% / +1.95% | 54.5% / +1.95% | 51.5% / +1.59% |
| Near-miss win5 / avg5 | 48.4% / −0.30% | 52.0% / +1.74% | 52.0% / +1.74% |

**Part B changed no trade, no grade and no outcome** — 63 trades, identical rows, identical
5- and 10-session numbers. Its whole footprint is the 16 near-miss rows replaced by 8 labelled
observations (an unroutable short that cleared every gate now outranks a row that cleared none),
the ledger rows those observations bring with them, and the board copy telling the truth about why
a side is empty. That is what "additive" was supposed to mean, and it is what the numbers show.
The near-miss outcome shift (−0.30% → +1.74%) is not an improvement in near misses: it is a
different, smaller *set* of them, because the strongest 8 side-days are now observations instead.

**The turn-scoped rule is a real loosening, and the size of it should not be glossed:** holding-days
48 → 182 (3.8×), constructions 15 → 68, and dip rows go from 10 to 45 — **32 of the window's 63
trades are now dip-lane rows**, against 9 before. The trade count is unchanged because the board is
capped at 3 per side; the dip lane did not enlarge the board, it **displaced composite rows** on 17
of the 21 days (the other 4 are unchanged).

That displacement is where the outcome numbers come from:

| | prev run | turn-scoped run |
|---|---|---|
| **dip** trades | 9 (4 graded) — win5 **25.0%**, avg5 **−1.00%** | 32 (21 graded) — win5 **66.7%**, avg5 **+2.24%** |
| **composite** trades | 54 (44 graded) — win5 **54.5%**, avg5 **+2.80%** | 31 (27 graded) — win5 **44.4%**, avg5 **+1.54%** |
| all trades | 48 graded — 52.1% / +2.48% | 48 graded — 54.2% / +1.85% |

The dip lane's own record improves enormously (n went from 4 to 21, so the old −1.00% was never
worth much); the composite rows that survived the displacement did worse than the composite
population that preceded them. Net: **+2.1 pp win5, −0.63 pp avg5.** On 48 graded rows with an
excess-return sd near 10.7 that is **t ≈ 0.3** — the same "cannot tell them apart" verdict §7
reached, and it must not be read as either a win or a regression. Nor is the sample clean: 5-session
grades run out on 2026-08-04, so 11 of the 32 dip trades — most of the August cluster the rule
created — carry **no grade at all** yet.

The new `0.625` risk value is not a new tier: it is the existing half-size rung after the risk
ladder climbed to 1.25% mid-window.

### 11.3 The honest read

- **The acceptance criterion is met.** GLW constructs, on 07-31 and 08-03, at real levels, and both
  reads paid at 5 sessions. §4's "criterion 2 fails on its last clause" is now satisfied — by a
  rule change the owner ratified after seeing why it failed, not by tuning until it passed.
- **The lane still says no far more than it says yes.** GLW's 51% collapse is refused on all 13 of
  its falling days, and the 1:1 gate declined the two days when the recovery had already run.
- **The cost is concentration.** A third of the board's trades are now one lane's rows, and on
  08-06 and 08-10 the entire long side is dip rows. That is a real change in what the reader sees
  every morning, it is not measured by this window, and the first live weeks should be watched for
  it. Recommended follow-up (Stage 2, NOT done here): a per-lane cap, or dip rows competing on the
  same diversity gates rather than arriving via their own merge.
- **Nothing else moved.** Blank boards 0/21, blank sides 0/42, no A grade produced by any engine on
  this tape, and the A/B-without-contract tier still never fired.
- **Not measured, again:** any LLM lane. `dipNews` returned `unclear` on all 68 constructions, so
  the safety valve that is supposed to stand a dip down on a broken thesis was never once exercised
  — and the turn-scoped rule hands that valve **4.5× more work** in production than it had before.
  That is the single biggest gap between this replay and the live board.

Raw output: `replay-partB.json` and `replay-turnvol.json` beside the §1 files; the three-way diff
script is `turnvol-compare.mjs` in the same directory.
