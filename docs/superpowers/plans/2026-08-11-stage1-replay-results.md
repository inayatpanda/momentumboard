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
- **Stage 1b's own ship gate is §13** (the velocity doors against seven named runners, plus the
  attributed re-run of this window). That gate **FAILS** on its exit criterion — 39% green against
  a 60% floor — with the other four criteria passing. **The owner decides that too.**

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

The `close` column is the last close the engine could **see** on that board date (D−1 under the
point-in-time rule of §1), which is the price every level below is derived from.

| board date | close seen | holding | dip call | entry | stop | target | R:R | 5-session outcome |
|---|---|---|---|---|---|---|---|---|
| 2026-07-31 | 135.22 (07-30) | ✅ (3.6× volume **2 sessions ago**) | **built** | 135.22 | 114.50 | 166.00 | 1.49 | **HIT, +11.4% vs SPY** |
| 2026-08-03 | 138.25 (07-31) | ✅ (3.6×, 3 sessions ago) | **built** | 138.25 | 114.50 | 166.53 | 1.19 | **HIT, +13.8% vs SPY** |
| 2026-08-04 | 146.64 (08-03) | ✅ (3.6×, 4 sessions ago) | declined | — | — | — | 0.712 | — |
| 2026-08-05 | 159.89 (08-04) | ✅ (1.8×, 4 sessions ago) | declined | — | — | — | 0.358 | — |
| 2026-08-06 | 156.70 (08-05) | ❌ (best 1.4× in 5) | — | — | — | — | — | — |
| 2026-08-07 | 157.18 (08-06) | ❌ (best 1.4× in 5) | — | — | — | — | — | — |
| 2026-08-10 | 165.68 (08-07) | ❌ (best 1.4× in 5) | — | — | — | — | — | — |
| 2026-08-11 | 157.76 (08-10) | ❌ (best 1.4× in 5) | — | — | — | — | — | — |

*(The last four rows were previously collapsed to "2026-08-06 → 08-11 | 156.70 → 165.68", which
reads as a start-and-end pair. It was not one: 165.68 is the 08-07 close, seen by the **08-10**
board, and the window ends at 157.76. The dates and the closes now line up one for one.)*

**Reproducing the R:R column.** Every figure is `dipCall`'s own arithmetic on the bars the engine
saw — `target = entry + (high20 − entry)/2`, `stop = min(dip-window low, today's low)`,
`R:R = (target − entry) / (entry − stop)` — and both declines are worked through here because
the first draft of this table printed 0.63 and 0.18, which reproduce from nothing:

- **08-04** — entry 146.64, high20 **192.38** (the 09 Jul close, still inside the 20-session
  window), so target = 146.64 + (192.38 − 146.64)/2 = **169.51**; stop 114.50 (the 28 Jul low),
  so risk = **32.14** and reward = 22.87. **R:R = 22.87 / 32.14 = 0.712.**
- **08-05** — entry 159.89, same high20 192.38, target = **176.14**; risk = 159.89 − 114.50 =
  **45.39**, reward = 16.25. **R:R = 16.25 / 45.39 = 0.358.**

The conclusion is unchanged in both cases and in the same direction — both are far under the 1:1
floor, and the lane was right to decline — but a number nobody can reproduce is not evidence.

**One later change to the wording, not the verdict.** The `holding` column above quotes the run as
it happened, when `paidRvol` reported the window's LOUDEST session. It now reports the nearest
QUALIFYING one, so the same four days read "on 1.8× volume 1 / 2 / 3 / 4 sessions ago" instead of
"3.6× … 2 / 3 / 4 sessions ago" — the 3.6× print was the 28 Jul capitulation bar, and a 1.8×
session (29 Jul) sat nearer on every one of those boards. Same holding verdict, same levels, same
R:R; only the evidence the sentence names is closer to hand. The refusals from 08-06 are unchanged
("best 1.4× in 5") because a refusal still quotes the loudest print, which is the useful one there.

Both built rows published **grade B, 1% risk, catalyst `dip`**, and on 07-31 — the red-regime day that
was the baseline's only blank board — GLW was the **first trade on the board**. On 08-03 the
composite also published its opposing GLW short, as a shadow; F3's new condition was satisfied on
both days (the dip long published as a *sized* row, so it is entitled to demote). Whether the
demotion itself fired cannot be read off this harness — with an empty `levMap` (approximation #6)
every short is unroutable and shadows anyway.

The two declines matter as much as the two builds: on 08-04 and 08-05 the dip was still *holding*,
but price had run so far off the 114.50 low that the half-retrace target no longer paid for the
stop — R:R 0.712 and 0.358 against a 1:1 floor. **The lane refused to chase its own winner.** Then
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

---

## 13. Stage 1b — the velocity doors against their runners

**Ship gate for `docs/superpowers/plans/2026-08-12-stage1b-velocity-and-crypto.md` (Task 7).**
Produced 2026-08-12 at commit `53c31cf`. (Numbered §13 on the controller's instruction; this
document has no §12.) **VERDICT: the gate FAILS.** Four of its five criteria pass; criterion 3
— "≥60% of in-run entries exit green via the trail" — comes in at **39% (26 / 67)**. Nothing
below has been tuned and no threshold was moved: the failure is written up and the owner decides.

### 13.1 How the probe runs

```bash
# the runners (network: Yahoo 5y history, incl. 2025 for the quantum trio)
npx vite-node scripts/replay-window.ts -- --velocity-probe --out …/velocity-probe.json
```

`--velocity-probe` is a second mode of the same harness. For each of seven named runners it:

1. loads the full (5y) candle history through the shared `./.replay-cache` — 2 concurrent
   requests, 120 ms apart, one 30 s retry on a 429, and a symbol Yahoo refuses is recorded as
   MISSING and never synthesised. **0 symbols were missing**; 187 tapes are cached, 25 MB;
2. finds **the run** inside the search window from the candles: the largest low→high CLOSING
   advance, provided it clears +40% (`findRun`, a running-minimum scan, so it is the best pair
   in the window and not the first pair that clears the floor). The run's dates are printed;
3. walks the search window **session by session**, and on every session hands
   `classifyVelocity` the tape up to and including that close — the same view the engine has
   pre-open the next morning;
4. records **every** firing (both doors independently, not just the one that won the tie-break),
   calls `velocityCall` on it, and where an open door produced no call re-reads `velocityTrail`
   alongside to say **which** refusal it was;
5. simulates the exit forward with the **paper book's own walk** (`paperBook.ts`
   `manageOpenPositions`): from the session after entry, each close against
   `effectiveVelocityStop(publishedStop, tape-as-of-that-session, entrySessionIdx)`, then the
   2R target, then the 10-session horizon. **The entry-session index is passed** — walking the
   trail a session at a time without it is the defect the ratchet fix (`e0fa4f9`) exists to kill,
   and `scripts/replay-window.test.ts` now pins the difference on a washout-wick fixture.

The probe applies the LANE's gates and **not** the engine's `VELOCITY_MIN_CAP_USD_M` floor: it is
measuring the doors, not the discovery path. Runtime with a warm cache: **under a second**; the
cold fetch of 157 tapes is the long pole (a few minutes). Re-running is deterministic — the same
JSON twice.

### 13.2 The seven runners, and the runs the tape gave them

Named in the plan before any result was seen (C15), and pinned by a unit test so they cannot
drift. The run is found, never named:

| runner | search window | run found (largest closing advance ≥40%) | sessions | in-run firings | in-run entries |
|---|---|---|---|---|---|
| AAOI | 2026-01-01 → 2026-08-01 | 2026-01-08 33.01 → 2026-05-13 223.10, **+575.9%** | 86 | 9 | 9 |
| RKLB | 2026-01-01 → 2026-08-01 | 2026-03-30 57.38 → 2026-05-27 150.23, **+161.8%** | 40 | 3 | 3 |
| LUNR | 2026-01-01 → 2026-08-01 | 2026-02-05 14.79 → 2026-05-28 45.70, **+209.0%** | 77 | 4 | 4 |
| ASTS | 2026-01-01 → 2026-08-01 | 2026-05-05 63.87 → 2026-05-28 133.09, **+108.4%** | 16 | 1 | 1 |
| IONQ | 2025-01-01 → 2025-12-31 | 2025-03-10 18.27 → 2025-10-13 82.09, **+349.3%** | 150 | 9 | 9 |
| RGTI | 2025-01-01 → 2025-12-31 | 2025-01-13 6.05 → 2025-10-15 56.34, **+831.2%** | 190 | 25 | 21 |
| QBTS | 2025-01-01 → 2025-12-31 | 2025-01-13 3.83 → 2025-10-15 44.78, **+1069.2%** | 190 | 20 | 20 |

`findRun` was checked against a brute-force O(n²) scan of every pair in the window on AAOI, RGTI
and QBTS — same three runs, same dates, same advances.

**Note on criterion 4.** The maximum-advance pair makes the run's END its highest close by
construction (any higher close inside the run would be a bigger advance from the same low), so
"no entry on the run's single highest close" is, on this data, exactly "no entry on the run's last
session". It is computed independently anyway (`peakIdx`), and it is 0.

### 13.3 Per-runner detail

Every firing, in-run and out. `door (early/conf)` shows the chosen door and then which doors were
open — they OVERLAP, and on 10 sessions both were. `pos` is the entry's position in the run
measured in sessions (0 = the run's low, 1 = its high). Exits are the paper book's walk.

#### AAOI — run **2026-01-08 33.01 → 2026-05-13 223.10, +575.9%** (86 sessions)

145 sessions walked · door firings: early 2, confirmation 9 (both on 2) · chosen: early 2, confirmation 7 · constructed 9 · in-run entries 9

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-01-28 | yes | 0.15 | confirmation (n/Y) | 2 | 2.8× | 45.23 | 38.55 | 14.8% | 42.8 | trail 2026-02-04 | -11.8% |
| 2026-01-30 | yes | 0.17 | confirmation (n/Y) | 1 | 2.5× | 43.61 | 39.85 | 8.6% | 47.1 | trail 2026-02-04 | -8.5% |
| 2026-02-02 | yes | 0.19 | confirmation (n/Y) | 2 | 2.2× | 44.16 | 40.81 | 7.6% | 51.6 | trail 2026-02-04 | -9.6% |
| 2026-02-27 | yes | 0.40 | early (Y/Y) | 1 | 4.6× | 84.23 | 59.3 | 29.6% | 55 | trail 2026-03-13 | +14.9% |
| 2026-03-02 | yes | 0.41 | early (Y/Y) | 2 | 4.3× | 102.51 | 68.9 | 32.8% | 55 | trail 2026-03-13 | -5.6% |
| 2026-03-03 | yes | 0.42 | confirmation (n/Y) | 0 | 3.9× | 95.34 | 74.77 | 21.6% | 55 | trail 2026-03-13 | +1.5% |
| 2026-03-04 | yes | 0.43 | confirmation (n/Y) | 1 | 3.7× | 99.71 | 80.32 | 19.4% | 55 | trail 2026-03-13 | -2.9% |
| 2026-03-05 | yes | 0.44 | confirmation (n/Y) | 2 | 3.6× | 101.14 | 84.94 | 16.0% | 55 | trail 2026-03-13 | -4.3% |
| 2026-03-06 | yes | 0.45 | confirmation (n/Y) | 0 | 3.5× | 95.58 | 87.31 | 8.6% | 38.5 | target 2026-03-10 | +26.1% |

#### RKLB — run **2026-03-30 57.38 → 2026-05-27 150.23, +161.8%** (40 sessions)

145 sessions walked · door firings: early 1, confirmation 3 (both on 1) · chosen: early 1, confirmation 2 · constructed 3 · in-run entries 3

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-05-08 | yes | 0.70 | early (Y/Y) | 1 | 3.7× | 105.47 | 86.06 | 18.4% | 55 | horizon 2026-05-22 | +28.7% |
| 2026-05-11 | yes | 0.72 | confirmation (n/Y) | 2 | 3.2× | 117.35 | 93.02 | 20.7% | 55 | horizon 2026-05-26 | +22% |
| 2026-05-15 | yes | 0.82 | confirmation (n/Y) | 0 | 2.1× | 124.77 | 113.66 | 8.9% | 43.3 | target 2026-05-27 | +20.4% |

#### LUNR — run **2026-02-05 14.79 → 2026-05-28 45.70, +209%** (77 sessions)

145 sessions walked · door firings: early 0, confirmation 4 (both on 0) · chosen: early 0, confirmation 4 · constructed 4 · in-run entries 4

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-04-06 | yes | 0.52 | confirmation (n/Y) | 0 | 2.8× | 22.92 | 20.55 | 10.3% | 55 | horizon 2026-04-20 | +20.1% |
| 2026-04-07 | yes | 0.53 | confirmation (n/Y) | 0 | 2.7× | 22.73 | 21.03 | 7.5% | 55 | target 2026-04-16 | +20% |
| 2026-04-08 | yes | 0.55 | confirmation (n/Y) | 1 | 2.7× | 23.39 | 21.55 | 7.9% | 51 | target 2026-04-16 | +16.6% |
| 2026-05-27 | yes | 0.99 | confirmation (n/Y) | 1 | 2.1× | 40.34 | 35.68 | 11.6% | 49.3 | trail 2026-06-01 | -5.3% |

#### ASTS — run **2026-05-05 63.87 → 2026-05-28 133.09, +108.4%** (16 sessions)

145 sessions walked · door firings: early 0, confirmation 1 (both on 0) · chosen: early 0, confirmation 1 · constructed 1 · in-run entries 1

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-05-11 | yes | 0.25 | confirmation (n/Y) | 2 | 2.1× | 82.55 | 73.66 | 10.8% | 45.6 | stop 2026-05-12 | -11.6% |

#### IONQ — run **2025-03-10 18.27 → 2025-10-13 82.09, +349.3%** (150 sessions)

250 sessions walked · door firings: early 2, confirmation 9 (both on 2) · chosen: early 2, confirmation 7 · constructed 9 · in-run entries 9

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2025-03-14 | yes | 0.03 | confirmation (n/Y) | 1 | 2.0× | 25 | 22.39 | 10.4% | 46.7 | trail 2025-03-18 | -9.3% |
| 2025-05-08 | yes | 0.28 | confirmation (n/Y) | 1 | 2.7× | 31.84 | 29.49 | 7.4% | 41.3 | trail 2025-05-21 | +5.3% |
| 2025-05-13 | yes | 0.30 | confirmation (n/Y) | 2 | 2.6× | 33.22 | 31.15 | 6.2% | 37.9 | trail 2025-05-21 | +1% |
| 2025-05-22 | yes | 0.35 | early (Y/Y) | 1 | 6.4× | 45.79 | 36.3 | 20.7% | 55 | trail 2025-05-30 | -11.9% |
| 2025-05-23 | yes | 0.35 | confirmation (n/Y) | 0 | 5.1× | 45.69 | 38.39 | 16.0% | 55 | trail 2025-05-30 | -11.7% |
| 2025-05-27 | yes | 0.36 | confirmation (n/Y) | 1 | 4.8× | 48.04 | 40.53 | 15.6% | 55 | trail 2025-05-30 | -16% |
| 2025-05-28 | yes | 0.37 | confirmation (n/Y) | 0 | 4.6× | 47.56 | 42.09 | 11.5% | 55 | trail 2025-05-30 | -15.2% |
| 2025-05-29 | yes | 0.37 | confirmation (n/Y) | 0 | 4.4× | 43.2 | 42.34 | 2.0% | 53.8 | stop 2025-05-30 | -6.6% |
| 2025-09-12 | yes | 0.86 | early (Y/Y) | 2 | 4.9× | 55.61 | 46.16 | 17.0% | 55 | target 2025-09-23 | +35.1% |

#### RGTI — run **2025-01-13 6.05 → 2025-10-15 56.34, +831.2%** (190 sessions)

250 sessions walked · door firings: early 3, confirmation 25 (both on 3) · chosen: early 3, confirmation 22 · constructed 21 · in-run entries 21

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2025-05-05 | yes | 0.41 | confirmation (n/Y) | 0 | 2.4× | 9.69 | 9.42 | 2.8% | 30.2 | trail 2025-05-07 | -4.5% |
| 2025-05-06 | yes | 0.41 | confirmation (n/Y) | 1 | 2.4× | 9.78 | 9.5 | 2.9% | 35.4 | stop 2025-05-07 | -5.4% |
| 2025-05-08 | yes | 0.42 | confirmation (n/Y) | 1 | 2.7× | 10.31 | 9.64 | 6.5% | 37.8 | trail 2025-05-13 | -4.3% |
| 2025-05-14 | yes | 0.44 | early (Y/Y) | 1 | 3.9× | 11.64 | 10.48 | 10.0% | 50.8 | trail 2025-05-21 | -5.8% |
| 2025-05-15 | yes | 0.45 | confirmation (n/Y) | 0 | 3.4× | 11.54 | 10.71 | 7.2% | 36.9 | trail 2025-05-21 | -5% |
| 2025-05-16 | yes | 0.45 | confirmation (n/Y) | 1 | 3.2× | 11.85 | 10.97 | 7.4% | 37 | trail 2025-05-21 | -7.5% |
| 2025-05-19 | yes | 0.46 | confirmation (n/Y) | 2 | 3.0× | 12.05 | 11.21 | 7.0% | 29.3 | trail 2025-05-21 | -9% |
| 2025-05-20 | yes | 0.46 | confirmation (n/Y) | 0 | 2.8× | 11.92 | 11.37 | 4.6% | 45.8 | stop 2025-05-21 | -8.1% |
| 2025-05-22 | yes | 0.47 | early (Y/Y) | 1 | 3.1× | 13.86 | 11.85 | 14.5% | 45.1 | trail 2025-05-30 | -12.6% |
| 2025-05-23 | yes | 0.48 | confirmation (n/Y) | 2 | 2.8× | 14.02 | 12.33 | 12.0% | 43.3 | trail 2025-05-30 | -13.6% |
| 2025-05-28 | yes | 0.49 | confirmation (n/Y) | 0 | 2.5× | 14.16 | 13.06 | 7.8% | 43.8 | trail 2025-05-30 | -14.5% |
| 2025-05-29 | yes | 0.49 | confirmation (n/Y) | 0 | 2.5× | — | — | — | — | **no call** — risk 0.07 under the 1% floor (0.53% of entry) | — |
| 2025-06-11 | yes | 0.54 | confirmation (n/Y) | 1 | 2.7× | 12.52 | 11.84 | 5.4% | 30.9 | trail 2025-06-13 | -8.9% |
| 2025-06-12 | yes | 0.55 | confirmation (n/Y) | 0 | 2.5× | 12.1 | 11.9 | 1.7% | 36.1 | stop 2025-06-13 | -5.8% |
| 2025-07-16 | yes | 0.66 | early (Y/Y) | 1 | 5.4× | 16.56 | 13.59 | 17.9% | 47.6 | trail 2025-07-25 | -6.8% |
| 2025-07-17 | yes | 0.67 | confirmation (n/Y) | 2 | 4.5× | 17.14 | 14.38 | 16.1% | 55 | trail 2025-07-25 | -9.9% |
| 2025-07-21 | yes | 0.68 | confirmation (n/Y) | 0 | 4.1× | 16.08 | 15.24 | 5.2% | 50.9 | trail 2025-07-25 | -4% |
| 2025-07-22 | yes | 0.68 | confirmation (n/Y) | 0 | 4.1× | — | — | — | — | **no call** — risk 0.15 under the 1% floor (0.97% of entry) | — |
| 2025-08-15 | yes | 0.78 | confirmation (n/Y) | 0 | 2.3× | — | — | — | — | **no call** — risk 0.12 under the 1% floor (0.72% of entry) | — |
| 2025-08-18 | yes | 0.78 | confirmation (n/Y) | 0 | 2.4× | — | — | — | — | **no call** — risk 0.08 under the 1% floor (0.48% of entry) | — |
| 2025-09-12 | yes | 0.88 | confirmation (n/Y) | 2 | 2.9× | 19.09 | 16.63 | 12.9% | 51.4 | target 2025-09-18 | +29.6% |
| 2025-09-22 | yes | 0.91 | confirmation (n/Y) | 0 | 2.4× | 28.37 | 23.38 | 17.6% | 55 | target 2025-10-03 | +41.2% |
| 2025-09-23 | yes | 0.92 | confirmation (n/Y) | 1 | 2.3× | 31.46 | 25.18 | 20.0% | 55 | horizon 2025-10-07 | +39.6% |
| 2025-09-24 | yes | 0.92 | confirmation (n/Y) | 2 | 2.4× | 31.64 | 26.61 | 15.9% | 55 | target 2025-10-06 | +31.8% |
| 2025-09-26 | yes | 0.93 | confirmation (n/Y) | 0 | 2.0× | 31.18 | 28.58 | 8.3% | 34.3 | target 2025-10-03 | +28.5% |

#### QBTS — run **2025-01-13 3.83 → 2025-10-15 44.78, +1069.2%** (190 sessions)

250 sessions walked · door firings: early 2, confirmation 21 (both on 2) · chosen: early 2, confirmation 19 · constructed 21 · in-run entries 20

| date | in run | pos | door (early/conf) | streak | bestUp | entry | stop | risk | comp | exit | P&L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2025-03-18 | yes | 0.23 | confirmation (n/Y) | 0 | 3.3× | 10.8 | 8.4 | 22.2% | 55 | trail 2025-03-20 | -19.5% |
| 2025-03-19 | yes | 0.24 | confirmation (n/Y) | 0 | 3.1× | 10.6 | 8.89 | 16.1% | 55 | stop 2025-03-20 | -18% |
| 2025-05-08 | yes | 0.42 | early (Y/Y) | 1 | 8.4× | 10.42 | 7.88 | 24.4% | 55 | target 2025-05-20 | +58.9% |
| 2025-05-09 | yes | 0.43 | early (Y/Y) | 2 | 6.3× | 11.09 | 8.59 | 22.5% | 55 | target 2025-05-20 | +49.3% |
| 2025-05-12 | yes | 0.43 | confirmation (n/Y) | 0 | 5.4× | 10.72 | 9.07 | 15.4% | 55 | target 2025-05-20 | +54.5% |
| 2025-05-13 | yes | 0.44 | confirmation (n/Y) | 1 | 5.1× | 10.73 | 9.44 | 12.0% | 55 | target 2025-05-20 | +54.3% |
| 2025-05-14 | yes | 0.44 | confirmation (n/Y) | 2 | 5.0× | 11.08 | 9.8 | 11.6% | 55 | target 2025-05-20 | +49.5% |
| 2025-05-15 | yes | 0.45 | confirmation (n/Y) | 0 | 3.3× | 11.03 | 10.07 | 8.7% | 30.9 | target 2025-05-19 | +19.2% |
| 2025-05-16 | yes | 0.45 | confirmation (n/Y) | 1 | 2.1× | 12.25 | 10.56 | 13.8% | 35.5 | target 2025-05-20 | +35.2% |
| 2025-05-21 | yes | 0.47 | confirmation (n/Y) | 0 | 3.9× | 15.36 | 13.01 | 15.3% | 55 | trail 2025-06-05 | +7.2% |
| 2025-05-22 | yes | 0.47 | confirmation (n/Y) | 1 | 3.5× | 19.04 | 14.35 | 24.6% | 55 | trail 2025-06-05 | -13.5% |
| 2025-05-23 | yes | 0.48 | confirmation (n/Y) | 0 | 3.1× | 18.8 | 15.34 | 18.4% | 55 | trail 2025-06-05 | -12.4% |
| 2025-05-27 | yes | 0.48 | confirmation (n/Y) | 0 | 3.0× | 17.55 | 15.83 | 9.8% | 55 | trail 2025-06-05 | -6.2% |
| 2025-07-18 | yes | 0.67 | confirmation (n/Y) | 0 | 2.3× | 18.89 | 17.24 | 8.7% | 52.5 | trail 2025-07-28 | -2.9% |
| 2025-07-21 | yes | 0.68 | confirmation (n/Y) | 0 | 2.3× | 18.39 | 17.49 | 4.9% | 41.2 | target 2025-07-23 | +10.4% |
| 2025-07-23 | yes | 0.69 | confirmation (n/Y) | 1 | 2.2× | 20.3 | 18.13 | 10.7% | 45 | trail 2025-07-28 | -9.6% |
| 2025-09-22 | yes | 0.91 | confirmation (n/Y) | 0 | 3.0× | 25.67 | 22.25 | 13.3% | 55 | trail 2025-09-30 | -3.7% |
| 2025-09-23 | yes | 0.92 | confirmation (n/Y) | 1 | 2.8× | 27.52 | 23.42 | 14.9% | 55 | trail 2025-09-30 | -10.2% |
| 2025-09-24 | yes | 0.92 | confirmation (n/Y) | 2 | 2.2× | 27.72 | 24.38 | 12.0% | 48 | trail 2025-09-30 | -10.9% |
| 2025-09-25 | yes | 0.93 | confirmation (n/Y) | 0 | 2.1× | 26.34 | 24.81 | 5.8% | 34.7 | trail 2025-09-30 | -6.2% |
| 2025-12-23 | **OUT** | — | confirmation (n/Y) | 0 | 2.0× | 29.12 | 27.54 | 5.4% | 39.1 | stop 2025-12-24 | -5.5% |

**Out-of-run firings (they count against nothing, and are listed because they exist):** exactly
one — **QBTS 2025-12-23**, confirmation door, constructed at 29.12, stopped the next session at
−5.5%. Every other firing on all seven tapes fell inside the run.

### 13.4 Three quantities, counted separately

They are not the same number and the report must never let them merge:

| quantity | count |
|---|---|
| **door firings** — `earlyTriggered` | 10 |
| **door firings** — `confirmationTriggered` | 72 |
| …of which sessions where **both** were open | 10 |
| sessions with **any** door open | 72 |
| **chosen doors** (early wins the tie) — early | 10 |
| **chosen doors** — confirmation | 62 |
| **constructed calls** (`velocityCall` non-null) | 68 |
| open door, **no call** | 4 |

Every early firing was also a confirmation firing: the early door never opened alone on these
seven tapes. All four refusals are the **1% risk floor**, all four on RGTI, and each is printed
beside the read that produced it — the open-door detail reads affirmatively even on a session
that produced nothing, so both strings travel together:

| date | refusal (recomputed by calling `velocityTrail` alongside) | the read's own detail |
|---|---|---|
| RGTI 2025-05-29 | risk 0.07 under the 1% floor (0.53% of entry) | confirmation door: +20% over 5 sessions · holding the 8-EMA at 13.08 · 0 green days |
| RGTI 2025-07-22 | risk 0.15 under the 1% floor (0.97% of entry) | confirmation door: +21.3% over 5 sessions · holding the 8-EMA at 15.28 · 0 green days |
| RGTI 2025-08-15 | risk 0.12 under the 1% floor (0.72% of entry) | confirmation door: 4/5 up-days paid by a 2.3× up-day · holding the 8-EMA at 16.53 · 0 green days |
| RGTI 2025-08-18 | risk 0.08 under the 1% floor (0.48% of entry) | confirmation door: 3/5 up-days paid by a 2.4× up-day · holding the 8-EMA at 16.55 · 0 green days |

**Neither of the other two refusal branches fired once** — no `trail null`, no `trail ≥ entry`, on
**1,330** walked sessions across the seven tapes.

### 13.5 The 1% floor's calibration data, and `bestUpMult`

Risk distance `(entry − stop) / entry` across all 68 constructed calls — this is the number the
uncalibrated `MIN_RISK_FRAC = 0.01` is guessing at:

| bucket | calls |
|---|---|
| 0–1% | 0 (the floor's own definition) |
| 1–2% | 2 |
| 2–3% | 2 |
| 3–5% | 2 |
| 5–8% | 14 |
| 8–12% | 15 |
| 12–20% | 24 |
| ≥20% | 9 |

**The floor is doing very little work and what it does is at the edge.** 94% of constructed calls
sit above 5%; only 6 land in 1–5%, and the 4 refusals it produced were all between 0.48% and
0.97% — i.e. the floor is cutting at a place where the population is almost empty, and the four
tapes it cut were within a rounding error of passing. Whether 1% is the right number cannot be
settled by this sample; what the sample says is that moving it inside 0–5% changes at most six
calls out of 72.

`bestUpMult` (the loudest up-day inside the run window, against the 20-session baseline) across
constructed calls: **min 2.0×, median 3.0×, max 8.4×**. The 2× confirmation gate therefore sits
right at the bottom of the observed distribution — half of these calls were paid for at 3× or
better, and the door is not being carried by marginal volume.

### 13.6 The gate

| # | criterion | measured | verdict |
|---|---|---|---|
| 1 | ≥5 of the 7 runners fire at least one door inside their run | **7 / 7** | **PASS** |
| 2a | median in-run entry position ≤ 0.6 of the run | **0.458** | **PASS** |
| 2b | ≤ ⅓ of in-run entries beyond 0.8 | **12 / 67 = 17.9%** | **PASS** |
| 3 | ≥60% of in-run entries exit green via the trail | **26 / 67 = 38.8%** (green *by trail exit*: 5) | **FAIL** |
| 4 | zero entries on a run's single highest close | **0** | **PASS** |

**Gate verdict: FAIL** (criterion 3).

Both readings of criterion 3 fail and they fail in the same direction, so the wording does not
decide anything: 26/67 (38.8%) of in-run entries end green under the book's walk, and only 5/67
(7.5%) end green *because the trail fired*. Reported both ways rather than choosing the kinder one.

### 13.7 What the failure is made of

Exit anatomy across the 67 in-run entries:

| exit | n | green | mean P&L | median sessions held |
|---|---|---|---|---|
| trail (the ratcheted level fired) | 40 | 5 | **−7.1%** | 5 |
| target (2R) | 17 | 17 | **+34.2%** | 6 |
| horizon (10 sessions) | 4 | 4 | +27.6% | 10 |
| stop (published level, never raised) | 6 | 0 | −9.3% | 1 |

- **The trail is the whole story.** 40 of 67 entries die on the ratcheted trail, at a mean of
  −7.1%. The trail is `max(8-EMA, the lowest low of the five prior sessions)` and it RATCHETS, so
  on a fast mover it climbs into the price within days; the first ordinary pullback then takes the
  position out below entry. That is the lane's design working exactly as written — it is not a bug
  in the walk (hand-verified below) — but it produces a **low hit-rate, high-payoff** distribution,
  and criterion 3 is a hit-rate test.
- **Expectancy is positive, the win rate is not.** Mean P&L per in-run entry **+5.25%**, median
  **−5.0%**, sum +351.8% across 67 entries; best +58.9%, worst −19.5%. A 2R target with a fast
  trail is *supposed* to look like this. Criterion 3 asked for something a 2R momentum system does
  not naturally produce.
- **It is not the 10-session horizon.** Re-walking every entry with the horizon removed (a
  sensitivity, NOT the gate, and NOT a tuning proposal): **26/67 green, identically 39%**; 20
  targets instead of 17, 41 trail exits instead of 40, mean +5.36%. The horizon is not what is
  costing the green exits.
- **The early door is the better read on this sample**: 5/10 green, mean +14.4%, versus 21/57 and
  +3.6% for confirmation. n = 10 — worth nothing on its own, but it points the same way the plan's
  size caps already do (and the early door is the SMALLER cap, 0.25 vs 0.5, which is backwards
  from this evidence).
- **Wider stops did better, not worse**: 0–5% risk 1/6 green (mean −3.3%), 5–10% 8/21 (+2.1%),
  10–20% 12/31 (+7.5%), ≥20% 5/9 (+10.7%). A tight trail on a fast tape is a coin flip.
- **Later entries did better, not worse** — 0–0.4 of the run: 3/15 green, mean −8.6%; 0.4–0.6:
  13/32, +8.2%; 0.6–0.8: 3/8, +3.5%; 0.8–1.0: 7/12, **+15.8%**. Criterion 2 rewards early entries
  and criterion 3 penalises what early entries did on this tape. The two criteria are pulling in
  opposite directions and the owner should know that before deciding.
- **The 67 entries are not 67 independent samples.** Consecutive sessions on one name are the same
  move re-read: there are only **16 distinct episodes** (entries more than 10 sessions apart on one
  name) behind the 67 entries. AAOI's 6 March-cluster entries all die on the same 2026-03-13 break;
  RGTI's 21 entries are 6 episodes. Any percentage in this section has an effective n far below its
  denominator.

**The walk was verified by hand before this was called a failure.** AAOI 2026-01-28: entry 45.23,
published stop 38.55 (= `velocityTrail` on the entry tape); the trail is redrawn 38.78 → 39.85 →
40.81 → 41.99 over the next four sessions and the 2026-02-04 close of 39.90 is through the
ratcheted 41.99 — exit −11.8%, which is what the probe reports. QBTS 2025-05-08: entry 10.42,
stop 7.88, target 15.50, and the 2025-05-20 close of 16.56 takes the target — +58.9%, as reported.

### 13.8 The 21-day window, re-run and attributed

The window replay (2026-07-14 → 2026-08-11, 21 trading days) was re-run at HEAD on a **refetched**
candle cache (`./.replay-cache`, 154 symbols warmed, **0 missing**), and — so that nothing is
attributed by assertion — three more runs were made against **the same cache**: the §11
turn-scoped commit and the Stage-1 ship commit in `git worktree` checkouts (each running its OWN
copy of the harness, which is what its own production screens looked like), plus HEAD forced back
to a 25-deep gainers screen.

```bash
REPLAY_CACHE_DIR=…/.replay-cache npx vite-node scripts/replay-window.ts -- \
  --from 2026-07-14 --to 2026-08-11 --watch GLW,TSLA,NVDA --out …/replay-base371.json   # worktree 371e643
… same, in a worktree of de03c26                                                        # Stage 1 as shipped
npx vite-node scripts/replay-window.ts -- --gainers 25 …                                # HEAD, Stage-1 screens
npx vite-node scripts/replay-window.ts -- …                                             # HEAD, production's 50
```

| | `371e643` (§11) | `de03c26` (Stage 1 shipped) | HEAD, gainers 25 | **HEAD, gainers 50** |
|---|---|---|---|---|
| Sized trades | 63 | 63 | 63 | **63** |
| Watch rows | 134 | 130 | 130 | 130 |
| Near-miss rows | 26 | 34 | 34 | 34 |
| Ledger rows (shadows) | 288 (91) | 282 (89) | 282 (89) | 282 (89) |
| Grade A / B / C on trades | 0 / 55 / 8 | 0 / 55 / 8 | 0 / 55 / 8 | 0 / **46** / **17** |
| `riskPct` values seen | 0.5, 0.625, 1, 1.25 | 0.5, 0.625, 1, 1.25 | 0.5, 0.625, 1, 1.25 | 0.5, **1**, 1.25 |
| **Zero-trade days** | **0 / 21** | **0 / 21** | **0 / 21** | **0 / 21** |
| Blank sides | 0 / 42 | 0 / 42 | 0 / 42 | 0 / 42 |
| Dip holding-days | 182 | 182 | 182 | 182 |
| `dipCall` constructions | 68 | 68 | 68 | 68 |
| Dip rows sized | 32 | 32 | 32 | **31** |
| **Velocity rows on the board** | 0 | 0 | **0** | **0** |
| …velocity calls the LANE would have built | — | — | 75 | **77** |
| Lane share of trades (dip + velocity) | 50.8% | 50.8% | 50.8% | **49.2%** |
| Trades win5 / avg5 (n=48) | 54.2% / +1.81% | 54.2% / +1.81% | 54.2% / +1.81% | 54.2% / +1.75% |
| Trades win10 / avg10 (n=33) | 51.5% / +1.53% | 51.5% / +1.53% | 51.5% / +1.53% | **45.5% / +2.80%** |
| Dip trades win5 | 66.7% / +2.15% (n=21) | same | same | 65.0% / +1.84% (n=20) |
| Composite trades win5 | 44.4% / +1.54% (n=27) | same | same | 46.4% / +1.69% (n=28) |

**The tape reproduces §11.** The `371e643` column is the §11 "turn-scoped" column re-run on a
cache fetched three weeks later: trades 63, watch 134, near-miss 26, ledger 288 (91 shadow),
grades 0/55/8, dip holding-days 182, constructions 68, 32 sized dip rows, dip win5 66.7% — all
identical. The only differences are in the third decimal of the excess returns (avg5 +1.81% here
vs +1.85% published, avg10 +1.53% vs +1.59%, dip avg5 +2.15% vs +2.24%), which is Yahoo's own
revision of a few bars between the two fetches. The comparison below is therefore against a real
baseline, not a remembered one.

**Attribution, in the order the changes landed:**

1. **§11 → Stage-1 ship (`371e643` → `de03c26`)** — watch 134 → 130, near-miss 26 → 34, ledger
   288 → 282 (91 → 89 shadows). **No trade, grade, risk or outcome changed.** That is the Stage-1
   closing containment wave (observation labelling and dedup), already reviewed, and it is
   confined to rows the reader sees but does not size.
2. **Stage 1b's engine, at Stage-1 screens (`de03c26` → HEAD, gainers 25)** — **every single
   number is identical.** Trades, watch, near-miss, ledger, shadows, grades, risk values,
   outcomes: unchanged, row for row. The velocity lane, the hype clusters and the quarter/half
   sizing added **nothing** to this window, for two reasons that must be stated plainly:
   - **The velocity lane cannot fire in this harness at all.** `capUsdM` is `null` for every name
     (approximation #4 — there is no free point-in-time market-cap source), and
     `VELOCITY_MIN_CAP_USD_M` refuses an unknown cap by design. So the 21-day window says
     **nothing** about the lane's live behaviour; §13.1–13.7 is the only velocity evidence here.
     The harness now measures the counterfactual instead: over the names `buildBoard` actually
     evaluated, the lane's own gates opened on **85 name-days** and `velocityCall` would have
     built **77 calls** across the 21 days (36 distinct names — STAN.L 6, PYPL 5, VOD.L 5, SBUX 4,
     LMT 4, AMZN 4, PLTR 4, AAOI 4, …). Every one of them was blocked by the cap floor, not by the
     board.
   - **Clusters cannot fire either**, and for a cleaner reason: `social-history` is built from
     `deps.social`, which is empty in a price-only replay, so the record never accumulates a day
     and `clusterCandidates` returns nothing under its 7-day warm-up. No cluster elevated any name
     in any of the four runs, so **no displacement in this window is attributable to cluster
     elevation** — there is none to attribute.
3. **The 50-deep gainers screen (HEAD 25 → HEAD 50)** — the only Stage-1b change with a footprint
   on this window, and it is real. **Ten of the 21 days** see a board change. Every sized-trade
   displacement is the same name arriving:

   | day | trade displaced | by | watch-row changes |
   |---|---|---|---|
   | 07-14 | JACK (comp 26.0) | **PATH** (34.9) | out: GS 22.0, AMD 21.7, PYPL 21.6 · in: NET 26.4, JACK 26.0, PANW 24.1 |
   | 07-15 | — | — | out: GE 26.0 · in: AFRM 31.8 |
   | 07-16 | RBLX (35.6) | **PATH** (46.7) | out: LCID 28.6 · in: RBLX 35.6 |
   | 07-17 | AFRM (36.8) | **PATH** (47.4) | out: MS 28.7 · in: AFRM 36.8 |
   | 07-20 | — | — | out: ZS 24.6 · in: PATH 27.5 |
   | 07-21 | ADBE (34.9) | **PATH** (55.6) | out: ETH-USD 29.5 · in: ADBE 34.9 |
   | 07-22 | NFLX (36.6) | **PATH** (58.8) | out: JACK 33.1 · in: NFLX 36.6 |
   | 07-23 | — | — | out: LLY 25.5 · in: TMO 27.1 |
   | 07-30 | — | — | out: ZS 26.8 · in: SBUX 28.7 (C) |
   | 08-03 | — | — | out: IRWD 37.5 · in: HPE 32.7 |

   PATH is a mid-cap that sat between rank 26 and rank 50 of the gainers list on those days —
   precisely the population the depth change was made for (`4597167`). It displaced five sized
   trades, each time on a higher composite than the row it replaced, and each displaced row
   dropped to the watch column rather than off the board.

   **The composite-call changes those five rows cause, traced rather than asserted.** Nine trades
   change grade B → C and twelve change `riskPct`, and **not one of them has a different
   composite** — e.g. 07-30 EFOR 38.1 in both runs, 08-03 GLW 54.0 in both. What moved is the
   *calibrated probability*: EFOR 0.44 → 0.42, GLW 0.43 → 0.41, COIN 0.45 → 0.42, RBLX 0.63 →
   0.50. The five extra PATH rows entered the carried ledger, graded, and shifted the calibration
   buckets those later rows are scored through; rows sitting on the B/C probability boundary
   crossed it, and the risk ladder lost its 0.625 rung on 08-10 for the same reason. So the grade
   distribution's 55/8 → 46/17 is **not** nine independent regrades — it is five displacements
   plus their downstream effect on a state that carries. The window's own outcome numbers barely
   move at 5 sessions (54.2% / +1.81% → 54.2% / +1.75%) and move at 10 (51.5% / +1.53% → 45.5% /
   +2.80%) on n = 33 with the excess-return spread this window has: not a signal.
4. **Zero-trade days stayed 0/21 in all four runs**, and blank sides 0/42. Nothing regressed.

**Lane share of trades.** dip + velocity = **31 / 63 = 49.2%** at HEAD (32/63 = 50.8% before the
depth change), and velocity contributes **none** of it in this harness. The Stage-1 concentration
warning therefore stands unchanged and unmeasured for the new lane: the live board will add
velocity rows on top of a board that is already half dip rows, and this replay cannot say how many.

**How many velocity rows lost their trade slot to the 25-55 band?** On the board: **zero**, because
no velocity row reached one — the cap floor took them first, so the band never got the chance to.
On the counterfactual: of the 77 calls the lane would have built, **40 (51.9%)** carry a composite
BELOW the weakest sized long the composite lane put on the board that day, and 37 (48.1%) are at or
above it. That is the honest shape of the disadvantage — roughly half of the lane's calls would
have to win a competition their 25-55 band caps them out of — but it is a counterfactual computed
outside `buildBoard`, not an observed loss, and it should be re-measured live where caps are known.

### 13.9 The honest read

- **The doors find the runners.** 7/7 fire inside their run, the median entry sits at 0.458 of the
  move, only 18% of entries are past 0.8, and nothing is bought on a run's highest close. The
  thing the lane was built to do — say "this is moving" while the move is still young — it does.
- **The exit is where it fails.** 40 of 67 entries die on the ratcheted trail at a mean of −7.1%,
  and only 17 reach the 2R target. The system is +5.25% per entry in expectation and green on 39%
  of entries; the gate asked for 60% green. **These are not the same question, and criterion 3
  measured the one the lane was not designed to win.** That is a statement about the gate as much
  as about the lane, and it is the owner's call, not the harness's: no threshold has been moved.
- **The two criteria disagree with each other.** Criterion 2 rewards buying early; on this tape the
  early entries are the losing ones (0–0.4 of the run: 3/15 green, −8.6%) and the late ones the
  winners (0.8–1.0: 7/12, +15.8%). Whatever is decided about criterion 3 should be decided knowing
  that tightening entries toward the start of a run would have made criterion 3 *worse*.
- **The evidence is thinner than 67 sounds.** 16 distinct episodes, 7 names, two thematic clusters
  (2026 space/optical, 2025 quantum), and the 2025 quantum trio alone supplies 50 of the 67 entries
  — RGTI 21 and QBTS 20 of them.
  Whatever the owner decides should not be decided as though this were 67 independent trades.
- **The 21-day window measures none of this.** The lane is invisible there — cap-unknown fails the
  liquidity floor — and clusters are invisible too (no social record exists in a price-only
  replay). The only thing that window can and does say is that **nothing regressed**: 0 zero-trade
  days, 0 blank sides, identical rows at identical screens, and one attributable, intended
  displacement from the 50-deep gainers.
- **Not measured, still:** the lane against real market caps, against real cluster elevation,
  against the earnings calendar, and against slippage — every entry here is filled at the close it
  fired on, which is the most generous possible fill for a momentum door.

Raw output: `velocity-probe.json` (per-runner firings, refusals, exits, the gate object and the
histogram), `replay-head50.json`, `replay-head25.json`, `replay-base-de03.json`,
`replay-base371.json`, and the comparison script `compare.mjs`, all in the session scratch
directory; all are regenerable from the commands above against `./.replay-cache`. The probe's pure
helpers (`findRun`, `entryPosition`, `median`, `simulateTrailExit`, `bestUpDayMult`,
`velocityRefusal`, the runner list and the per-kind screen depths) are covered by
`scripts/replay-window.test.ts` — 34 tests, part of `npm test` (1,075 passing).

### 13.10 Owner decision — 2026-08-12

**Gate criterion 3 failed as written, and the owner did not revise it after seeing the result.**
39% of in-run entries exited green against a 60% bar; the same 67 entries were +5.25% per entry in
expectation (median −5.0%, 40 small trail deaths at −7.1% against 17 targets at +34.2%). A hit-rate
test is the wrong yardstick for a small-losses/ridden-winners design, but moving a threshold after
reading its verdict is exactly the move this document exists to prevent. So the lane ships instead
on the repo's own **earn-influence** rule: **SHADOW-FIRST — graded, unsized, earning its size on
the live tape.** `VELOCITY_SHADOW_FIRST = true` (`netlify/functions/lib/engine.ts`) passes
`forceShadow` on the velocity `publishCall`, so every velocity row publishes as a shadow: zero
`riskPct`, no instrument, absent from the reader's board, present in `predictions:${date}`, still
carrying `catalyst.kind 'velocity'`, `setup 'velocity'` and `trail 'velocity'`, and still graded —
so calibration, the setup family and the Brier trail all learn from it while the reader risks
nothing. The risk ladder deliberately does **not** learn from it: a rung is earned on calls the
reader could have taken. **Flip condition:** the flag goes to `false` only on the owner's explicit
word, once the shadow ledger says what the lane is worth on the live tape (the `velocity:long:*`
setup buckets and the scorecard's shadow lane are where that answer accumulates). Nothing else in
the lane was tuned; the door caps (0.25 / 0.5) are untouched and revive with the flag.

Two consequences were decided with it, both coherent with shadow-first rather than incidental:

- **An unknown cap is admitted while the lane is shadowed** (`capUsdM == null ? !VELOCITY_SHADOW_FIRST : capUsdM < VELOCITY_MIN_CAP_USD_M`).
  §13.8 is the reason: a point-in-time replay knows no caps, so the floor refused every name — 85
  name-days of open doors and **77 would-be calls that never entered the record at all**. A shadow
  carries no money, and starving the learning record was the costlier failure. This admits an
  *unknown* cap, never a *small* one: a known sub-$20M name is still refused in both modes, and
  the moment the lane is sized, unknown-never-passes returns with it.
- **An unsized row never costs the reader a sized one** [F3]. A shadowed velocity long does **not**
  demote the opposing composite short and does **not** suppress the same-symbol short near miss.
  Both cures exist to stop the board contradicting itself over a row the reader can take; a shadow
  says nothing to the reader, so there is no contradiction to cure, and applying them anyway would
  hand back an empty side in exchange for nothing.

The suite specifies **both** modes: the velocity tests import `VELOCITY_SHADOW_FIRST` and branch,
with real assertions on each side, so the sized behaviour cannot rot while the lane is shadowed.
Verified by running the full suite with the flag `true` and again with it `false` — 1,078 passing
either way.

---

## 15. Stage 2 — the curve, the grades, and the voice, measured

(§12 and §14 were never written; the numbering follows the plan's task numbers, not this
document's own sequence.)

**Verdict: the gate PASSES on all eight criteria.** The numbers are below, followed by three
things the gate did not ask about and the owner should see anyway — the 2 dp rounding, the risk
ladder, and how little the new eligibility floor actually did.

### 15.1 What was run

Four replays over the same 21 trading days and the **same candle cache**, so no bar differs
between them. The cache (`./.replay-cache`, 187 symbols) was refetched on 2026-08-12; 185 of the
187 series carry a bar for 2026-08-12, which is what makes 10-session outcomes gradable through
2026-07-29. **These are not the §1/§7 numbers and are not meant to be** — that run used a cache
whose last bar was 2026-08-11. Both arms of every comparison below were re-run against this cache.

```bash
# 1. the new engine, at HEAD
npx vite-node scripts/replay-window.ts -- --from 2026-07-14 --to 2026-08-11 \
  --watch GLW,TSLA,NVDA --out $S/replay-new.json                                    # d1d7dd6

# 2. the A-reachability probe: the SAME code path, with the calibration blob replaced
#    every morning by aReachableState() immediately before buildBoard
npx vite-node scripts/replay-window.ts -- --plant-a --from 2026-07-14 --to 2026-08-11 \
  --out $S/replay-aprobe.json                                                       # d1d7dd6

# 3. the baseline — a worktree of the pre-stage-2 commit with THIS script copied in
git worktree add $S/wt-baseline 2ae4484 --detach
ln -s "$PWD/node_modules" $S/wt-baseline/node_modules
cp scripts/replay-window.ts $S/wt-baseline/scripts/replay-window.ts
cd $S/wt-baseline && REPLAY_CACHE_DIR="$PWD/.replay-cache" npx vite-node scripts/replay-window.ts -- \
  --baseline --from 2026-07-14 --to 2026-08-11 --watch GLW,TSLA,NVDA --out $S/replay-baseline.json

# 4. …and a SECOND worktree at the commit immediately BEFORE the expected-move floor,
#    which is the only way the floor's own effect can be attributed rather than assumed
git worktree add $S/wt-mid b1f1a01 --detach   # everything of stage 2 except Task 4 and the voice
cd $S/wt-mid && REPLAY_CACHE_DIR="$PWD/.replay-cache" npx vite-node scripts/replay-window.ts -- \
  --from 2026-07-14 --to 2026-08-11 --watch GLW,TSLA,NVDA --out $S/replay-mid.json

# 5. the gate itself — pure aggregation over the four JSONs
npx vite-node scripts/replay-window.ts -- --aggregate \
  --new $S/replay-new.json --base $S/replay-baseline.json \
  --mid $S/replay-mid.json --aprobe $S/replay-aprobe.json --out $S/stage2-gate.json
```

| run | commit | `modelVersion` | what it is |
|---|---|---|---|
| baseline | `2ae4484` | 2 | the engine as it shipped after stage 1b |
| pre-floor | `b1f1a01` | 3 | EMA stack + owner-ordered weights + the probability curve + the born-below cap |
| **new** | `d1d7dd6` | 3 | …plus the expected-move floor (T4) and the voice (T5) |
| A-probe | `d1d7dd6` | 3 | the new engine with a planted calibration |

Total runtime for all five commands: **under 90 seconds**, cache warm.

### 15.2 The eight criteria

| # | criterion | measured | verdict |
|---|---|---|---|
| 1 | zero-trade days 0, blank sides 0 | 0/21 blank boards, 0/21 zero-trade days, 0 blank sides — in **all three** runs | **PASS** |
| 2 | B ≤ 75% of graded board trade rows | **57.1%** (36 B of 63), against 90.5% baseline | **PASS** |
| 3a | ≥ 15 distinct probabilities | **16** across 503 scored rows (132 before the 2 dp round — §15.5) | **PASS** |
| 3b | monotone in every probed context | **0 violations**, 20 contexts × 27 samples, 4 states | **PASS** |
| 4 | an A is reachable end-to-end | **157** grade-A board rows on the synthetic probe (61 of them sized) | **PASS** |
| 5a | win5/avg5 within noise | avg5 **t = −0.346**; win5 t = +0.088 | **PASS** |
| 5b | Brier(new) ≤ Brier(old) + 0.02 | **0.2552** vs **0.2663** — an improvement of 0.011 | **PASS** |
| 6 | thesis + falsifier, zero banned tokens | 63/63 trade rows, **0 defects** | **PASS** |

### 15.3 Criterion 2 — grades

| | baseline `2ae4484` | pre-floor `b1f1a01` | new `d1d7dd6` |
|---|---|---|---|
| board **trade** rows | 63 | 63 | 63 |
| A | 0 | 0 | 0 |
| B | 57 (**90.5%**) | 36 (**57.1%**) | 36 (**57.1%**) |
| C | 6 (9.5%) | 27 (42.9%) | 27 (42.9%) |
| board graded rows (trades + watch) | 192 — B 75.0% | 195 — B 43.6% | 195 — B 43.6% |
| ledger rows | 308 — B 53.2%, 96 null-graded | 310 — B 30.3%, 106 null | 308 — B 30.5%, 104 null |
| `riskPct` values seen | {0, 0.5, 1, **1.25**} | {0, 0.5, 1} | {0, 0.5, 1} |

The criterion is read on **trade rows**, which is the population the 100% → 83% lineage was
measured on. Every other cut is printed beside it so the denominator cannot be chosen after the
fact; the criterion passes on all of them.

**What moved the number is the B rung's new evidence floor, not the curve's shape.** A B now
requires `nEff ≥ 15` as well as `p ≥ base + 0.05`, and 27 rows that were full-size Bs are half-size
Cs because the evidence under them was thin. That is the tightening doing exactly what it was
built for — and it is *reader-visible*: 27 rows of the window carry half the size they used to.

`grade C` is doing two jobs on the row and the histogram separates them: a null grade is stored as
`'C'` (`engine.ts`, `grade ?? 'C'`), recoverable only through `shadow`/`belowBase`. On the board no
row was null-graded in any run (`belowBase` never fired once in 21 days — the "below our base rate,
tape-dependent" watch row is unexercised code in this window). In the ledger, 104 of the new run's
214 Cs are suppressed rows, i.e. shadows.

### 15.4 Criterion 3 — the probability, and what "the step function is dead" actually means

| | baseline | new |
|---|---|---|
| every scored row | n=500, **17 distinct**, 0.260 → 0.570, sd 0.0534 | n=503, **16 distinct**, 0.310 → 0.460, sd 0.0385 |
| band 25-40 | n=377, 12 distinct | n=307, 12 distinct |
| band 40-55 | n=97, 6 distinct | n=163, 10 distinct |
| band 55-70 | n=26, 3 distinct | n=33, 8 distinct |
| band 70+ | — never sampled | — never sampled |

**The distinct-value criterion passes, and it is a weak test.** The baseline scores *higher* on it
(17 vs 16). That is not a paradox: a four-step staircase, read across 21 days, two sides and three
regimes, while the buckets underneath it fill, produces plenty of distinct values. The count cannot
tell a curve from a staircase, so the harness measures the thing the criterion was reaching for:

> **within one day and one (side, regime), what share of row pairs at DIFFERENT convictions read
> DIFFERENT probabilities?**

|  | baseline | new (stored 2 dp) | new (unrounded curve read) |
|---|---|---|---|
| all pairs | 1328/3610 = 36.8% | 1165/3622 = 32.2% | — |
| pairs inside the evidenced interior (32.5 ≤ \|composite\| ≤ 62.5) | 930/1776 = **52.4%** | 941/2467 = **38.1%** | 1364/2467 = **55.3%** |
| distinct values | 17 | 16 | **132** (0.3107 → 0.4591) |

Read those three columns together and the honest sentence falls out: **the read path is a genuine
curve — 132 distinct values where the staircase had 17 — and `engine.ts`'s 2 dp rounding quantises
it back down to 16 before the number is stored.** The curve over this window spans only 0.31→0.46,
so two hundredths of probability is a wide step relative to the slope; the rounding costs more
resolution than the banding used to. That is the display decision recon §3.3 flagged
(`engine.ts:1148`) and it is **not tuned here** — it is reported, and it is the owner's call.

**Monotonicity is asserted on the synthetic probe**, not on the window, because the window never
produced a 70+ composite and a monotonicity claim over bands nothing landed in is a claim about a
fixture. Four states, each walked 26 → 78 in steps of 2, in every (side, regime, cohort) that state
carries evidence for:

| state | contexts | violations |
|---|---|---|
| the committed seed's own shape (recon §3.2 — the documented inversion) | 6 | **0** |
| a thin-and-lucky top band (the shrinkage inversion the running-max guard exists for) | 2 | **0** |
| the A-reachable plant | 6 | **0** |
| the window's own final calibration blob | 6 | **0** |

The probe is not vacuous, and the tests say so two ways: an injected decreasing read is caught
(`monotonicityViolations` finds it), and the seed shape's **raw** per-band Laplace values are
asserted to be non-monotone before the shipped read path is asserted to repair them — so the second
assertion is measuring a repair, not an absence of damage.

**Bands the window itself sampled:** 25-40 (n=307), 40-55 (n=163), 55-70 (n=33). Nothing reached
70+. The 70+ read is therefore exercised by the probe alone.

### 15.5 Criterion 4 — A-reachability

**Organic As in this window: ZERO — in all three runs, on the board and in the ledger.** The
committed seed cannot produce one and this window did not build enough evidence to change that: its
best read tops out at 0.4591 against a base rate of ~0.379, a gap of 0.08 where an A needs 0.10 on
`nEff ≥ 30`. **The seed does not support an A, and 21 days of live tape does not fix that.** Stage
2 made A *reachable*; it did not make it *reached*.

The synthetic probe answers the reachable half. `aReachableState()` plants six long buckets
(n=200 each, rising hit rates) and three 1,000-observation short buckets at a 0.20 rate whose only
job is to hold the base rate DOWN — an A is a claim about a gap, and a plant that lifts both sides
of the gap proves nothing. Base rate 2042/4804 = **0.4251**; a long at composite 40 reads **0.766**
on `nEff = 200`. Through the real `buildBoard`, every day, with the blob re-planted each morning:

- **157 grade-A board rows** over 21 days (173 in the ledger)
- **61 of them sized** at the full rung (`riskPct` 1.0). The other 96 are grade-A rows the board's
  own **3-trades-per-side cap** demoted to watch — the cap, not the grade, is what limits them.
- the born-below cap is **not** bypassed by the plant: a long at composite 26 still reads
  `belowEvidence` and still grades C. Pinned in the tests.
- the poisoned short side suppresses, as designed.

### 15.6 Criterion 5 — outcomes and Brier

Sized trade rows only. 5-session outcomes are gradable through 2026-08-05, 10-session through
2026-07-29.

| | n graded | win | avg excess | Welch t |
|---|---|---|---|---|
| **5d** baseline | 48 | 56.3% | **+2.294%** | |
| **5d** new | 49 | 57.1% | **+1.610%** | **t = −0.346** (df 92.4) on the average; t = +0.088 on the win rate |
| **10d** baseline | 33 | 51.5% | +3.836% | |
| **10d** new | 33 | 48.5% | +3.591% | t = −0.124; win t = −0.243 |

**This window still cannot tell the two engines apart on outcomes** — the same conclusion §7
reached, on a different cache and a different engine. Every t is inside ±0.35.

**Brier, by scoring epoch** (the `modelVersion` stamp is the only thing separating them, which is
the whole reason the 2 → 3 bump exists):

| epoch | rows with a 10d outcome | mean (p − hit)² |
|---|---|---|
| `modelVersion: 2` — the baseline ledger | 165 | **0.2663** |
| `modelVersion: 3` — the new ledger | 164 | **0.2552** |

**Δ = −0.0111.** The continuous read is *better* calibrated than the staircase on this window, by
about a hundredth. Well inside the +0.02 the gate allowed, and in the right direction — though on
164 rows this is a hint, not a proof.

### 15.7 The per-day table

`T/W/NM` = sized trades / watch rows / near misses. `(B·C)` = the grade split of the trade rows.

| date | regime | base T/W/NM (B·C) | new T/W/NM (B·C) | new base rate | new ledger |
|---|---|---|---|---|---|
| 2026-07-14 | amber | 3/6/2 (3·0) | 3/6/2 (1·2) | 0.3670 | 17 |
| 2026-07-15 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-16 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 16 |
| 2026-07-17 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-20 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-21 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-22 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-23 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-24 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-27 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-28 | amber | 3/6/2 (3·0) | 3/6/2 (3·0) | 0.3670 | 14 |
| 2026-07-29 | amber | 3/7/0 (0·3) | 3/7/0 (0·3) | 0.3692 | 15 |
| 2026-07-30 | amber | 3/6/2 (0·3) | 3/7/0 (0·3) | 0.3702 | 15 |
| 2026-07-31 | **red** | 3/6/2 (3·0) | 3/7/0 (0·3) | 0.3691 | 17 |
| 2026-08-03 | amber | 3/7/0 (3·0) | 3/7/0 (0·3) | 0.3677 | 16 |
| 2026-08-04 | amber | 3/6/2 (3·0) | 3/6/2 (0·3) | 0.3711 | 14 |
| 2026-08-05 | amber | 3/6/2 (3·0) | 3/6/2 (0·3) | 0.3731 | 13 |
| 2026-08-06 | amber | 3/6/2 (3·0) | 3/6/2 (2·1) | 0.3774 | 17 |
| 2026-08-07 | amber | 3/6/2 (3·0) | 3/7/0 (2·1) | 0.3793 | 16 |
| 2026-08-10 | amber | 3/6/2 (3·0) | 3/6/2 (1·2) | 0.3790 | 15 |
| 2026-08-11 | **green** | 3/7/0 (3·0) | 3/7/0 (0·3) | 0.3786 | 11 |

Three sized trades every day in every run, because the board caps the actionable list at **3 per
side** and the short side never carries a sized trade at all (`levMap` is empty by design — an
unroutable short is a shadow). `tradelessSides` is therefore 21/21 in all three runs, exactly as it
was in §3, and it is a property of the harness's config, not of stage 2.

### 15.8 The floor-change census — both directions, attributed

Comparing the pre-floor tree `b1f1a01` with `d1d7dd6` isolates **Task 4 alone** (the only other
thing in between is the voice, which cannot change what publishes):

| direction | board rows | ledger rows |
|---|---|---|
| **admitted** (the old floors rejected, the new one accepts) | **0** | **0** |
| **suppressed** (the old floors accepted, the new one rejects) | **0** | **2** |

The two suppressed rows, named:

| row | \|composite\| | `capacityPct` | expected move | old floor | new floor |
|---|---|---|---|---|---|
| **MCD short, 2026-08-04** | 21.8 | 4.1 | **0.9%** | sleeve floor 3 → admitted | needs ≥ 1.0% → **refused** |
| **PG short, 2026-08-10** | 20.6 | 4.2 | **0.9%** | sleeve floor 3 → admitted | needs ≥ 1.0% → **refused** |

**Both are core-sleeve names, and that is the whole story of this census.** The commit that shipped
the floor claimed the change is one-way looser ("no name the flat floor admitted can be rejected
now"), and for *ordinary* names it is: at the aggressive dead zone the new test reproduces the old
one exactly (0.20 × 5 = 1.0) and loosens above it. **The claim does not cover the sleeve**, which
lost `SLEEVE_CAPACITY_FLOOR = 3` in the same commit and now has to clear the ordinary bar. These
two rows are that trade-off, measured.

Two mitigations, both real and neither a defence:
- both were **unshortable shorts published as shadows** — the reader never saw either, and both now
  appear as near misses instead, so the day is no blanker than it was;
- the loosening had nothing to admit on this window. Exactly **one** of the 503 published rows has
  `capacityPct < 5` (MCD long-side read, 2026-07-20: cap 4.0, |composite| 28.3, expected move 1.1%)
  and it is *itself* a sleeve name, so the retired sleeve floor of 3 already admitted it. Every
  other published row clears cap ≥ 5 and was never near either floor.

**The full stage-2 diff**, for scale — this is everything, not the floor:

| baseline `2ae4484` → new `d1d7dd6`, board graded rows | count |
|---|---|
| shared (same date, symbol, side) | 142 |
| new-only | 53 |
| baseline-only | 50 |
| …of the new-only, core-sleeve names | 37 (SHOP, APP, META, PANW, NET, ZS, SNOW, ABBV, PM, RTX, SHEL.L, CVX, VOD.L, LMT, NOW, TMO, BP.L, LCID, PYPL, AAOI, TSLA…) |
| …of the baseline-only, core-sleeve names | 38 (AMD, GS, RR.L, GE, LCID, ADBE, JNJ, LLOY.L, ZS, BP.L, SNOW, UNH, COP, MSTR, OXY, BLK, SBUX, SLB, DOW, MU, COIN, AAPL, AZN.L…) |

The board churned ~35% of its rows across stage 2 and the sleeve gained and lost in almost equal
measure. The re-based weights and the EMA stack own that churn, not the floor — the floor moved two
shadows.

### 15.9 The born-below cap, and what it cost in leverage

| | count |
|---|---|
| reads extended DOWNWARD off the bottom of the evidence (`belowEvidence`) | **117** of 503 |
| …of which the cap actually demoted (uncapped grade was A or B) | **56** |
| …demoted rows still carrying size (a full trade became a half) | **4** |
| …rows that lost **ETP eligibility** | **0** |
| …rows carrying an actually routed instrument, anywhere in the window | **0** |

The de-leveraging effect of the born-below cap on this window is **nil, for two independent
reasons, and both need saying because only one of them is about the cap:**

1. `levMap` is `{}` in this harness on purpose (§1), so **no row is routed to an ETP in any run**
   and none can lose one. The eligibility line above is a counterfactual and the harness measures
   the zero rather than assuming it.
2. Even as a counterfactual it is zero, because the **new run never leaves risk rung 0**, and
   `leverageAllowed` routes nothing at rung 0 for any grade. The cap withheld 56 grades; it
   withheld no leverage, because there was none to withhold.

The cap is nonetheless the single largest behavioural change in stage 2: 117 rows — nearly a
quarter of everything scored — are reads the engine extended downward off the bottom of its own
evidence, and 56 of them would otherwise have claimed a B. Every composite below **32.5** (the
lowest band midpoint) is in that region by construction, and this window's composites start at
15.8. **A call under 32.5 conviction can never be graded above C, whatever the calibration says.**
That is the rule working as designed, and it is worth the owner knowing how much of the board it
touches.

### 15.10 Two things the gate did not ask about

**The risk ladder did not promote.** The baseline promoted R0 → R1 on 2026-08-10
(*"earned: 27 graded at R0, hit rate 60%, calibration improving"*); the new engine finished the
window still at **rung 0**, with 30 graded at R0. The rung multiplies every published `riskPct`, so
the baseline's last two days carry 1.25% where the new engine carries 1.0%. The cause is the
ladder's own 55% promotion bar applied to a noisy statistic: the new engine's sized stream hit
48.5% at 10 sessions against the baseline's 51.5% — a difference whose own t is **−0.24**, i.e.
indistinguishable from zero, sitting either side of a hard threshold. Not a defect; a threshold
effect on 33 observations. Worth watching in the live ledger rather than acted on here.

**The 2 dp rounding is now the resolution bottleneck.** §15.4 has the numbers. The curve reads 132
distinct probabilities and the row stores 16. Spec §4.2 asks for the raw probability printed beside
every grade; at two decimals, on a curve spanning 0.31–0.46, "raw" is coarser than the bands it
replaced. **No threshold was tuned to accommodate this and none should be** — it is a display
decision for the owner.

### 15.11 What this evidence shows, and what it does not

**It shows:** the staircase is gone from the read path and the curve is monotone under three
adversarial calibrations and the window's own; grade B has stopped being the default (90.5% → 57.1%
of trade rows) and the rows it stopped covering became half-size Cs rather than disappearing; an A
is now *architecturally* reachable, proven end to end through the real `buildBoard` on planted
evidence; the continuous read is slightly better calibrated than the staircase it replaced
(Brier −0.011); outcomes are unchanged inside a wide noise band; and every one of 503 scored rows
carries a thesis and a falsifier in the reader's language with zero internal names leaking — near
misses correctly carrying neither.

**It does not show:** that the engine will ever emit an A on real evidence (it emitted none in 21
days, and the seed arithmetically cannot); that the new engine is *better* than the baseline at
picking (every outcome t is under 0.35 — this window cannot tell them apart, and says so for the
second time); that the expected-move floor is an improvement (it changed two shadow rows, both in
the tightening direction, both sleeve names); that the 70+ band behaves in production (nothing
reached it, so only the probe has ever exercised it); or that any of this holds outside 21 amber
days in one summer, in a price-only replay with no news, no social, no insiders and no market caps
(§2 — every approximation there still applies, identically, to all four runs).

### 15.12 Reproducing

Raw output (`replay-new.json`, `replay-baseline.json`, `replay-mid.json`, `replay-aprobe.json` and
the aggregated `stage2-gate.json`) lives in the session scratch directory; all five are regenerable
from the commands in §15.1 in under 90 seconds against the committed candle cache.

The harness's pure helpers — `sliceBefore`, `tradingDays`, `synthScreens`, `sparkClosesFrom`,
`summariseBoard`, `doorsFor`, the velocity-probe helpers, and now the whole stage-2 aggregation
(`gradeHistogram`, `spreadOf`/`spreadByBand`, `withinContextResolution`, `brierOf`, `welch`,
`diffKeys`/`sleeveKeys`, `voiceDefects`, `probeGrid`/`contextsIn`/`monotonicityViolations`, the
three planted states and `bornBelowCensus`) — are covered by `scripts/replay-window.test.ts`:
**67 tests**, part of `npm test` (**1,242 passing**).
