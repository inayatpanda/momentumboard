# Where is the price now? — call status on the board

**Date:** 2026-07-25
**Status:** implemented — board and paper

## The problem

A call renders three fixed numbers — `in 12.04 · stop 11.03 · tgt 13.20` — and nothing else. A reader cannot tell whether the setup is still available, has already run, or was invalidated days ago.

This is worse than it looks. `priceAtPick` / `entry` is captured pre-open, so it is the **previous session's close**. By the time the 06:35 paper is read, price has often already moved past it. Reviewing the first 26 live calls (2026-07-02 → 07-25), scoring from that stale entry flattered the 5-day average by **+1.7pp**, and was optimistic on 13 of the 20 scoreable calls. The board asked the reader to assume the entry was still on offer.

The existing "Intraday flags" rail is a different thing: discrete level-touch events in a side panel, not a continuous readout on the call itself.

## Design

**`shared/engine/callStatus.ts`** — one pure function, both surfaces render it, so the app and the paper can never disagree.

```
callStatus({ side, entry, stop, target }, price) -> {
  price, pctFromEntry, pctToStop, pctToTarget, r, state
} | null
```

Every distance is expressed **in the trade's own direction**: positive always means "your way" or "not yet hit", for longs and shorts alike, so a reader never has to remember which side a short's stop sits on.

`state` is one of:

| state | meaning |
|---|---|
| `live` | between entry and target, stop intact |
| `extended` | already travelled ≥ 0.5R — entering here is chasing |
| `through-stop` | invalidated |
| `at-target` | the move asked for has happened |

`r` is multiples of the original entry→stop risk already travelled. `EXTENDED_R = 0.5` is the threshold: once half the original risk is banked, the reward left no longer pays for the risk of entering here. Using the trade's own geometry beats an arbitrary percentage — a 0.5R move means the same thing on a tight stop and a wide one.

Returns `null` for a missing or nonsensical price rather than inventing a status. A zero-width risk (`entry === stop`) reports `r = 0` instead of dividing by zero and calling everything extended.

## Board rendering

A line under the levels on every `ChartCard`:

```
in 12.04 · stop 11.03 · tgt 13.20
now 12.62 · +4.8% from entry · stop 12.6% away   [extended]
```

Green/red on the from-entry figure; a badge only when the state is not `live` (`through stop` = bad, `at target` = good, `extended` = warn).

**Cost: zero new requests.** Every card already loads candles — collapsed cards render a 190px chart — so the last close is in hand. This is deliberately last close, not a live tick: it is a swing board, and real-time streaming is a large change for little gain.

## The paper strip

Built server-side at READ time, not with the client-side fetch originally sketched here. The composer leaves an empty `<span data-call-status="TICKER"></span>` in each call block; `report.mts` fills it when the page is served.

Why the change: the report is also a PDF and an emailed document, and both use the stored HTML directly. Filling on read means the stored edition stays a clean record — no stale price, no JavaScript in a document destined for print — and it needs no public quote endpoint, which would otherwise have been an unauthenticated symbol-quoting proxy on a public page.

- `numericCalls()` persists the edition's levels as `report-calls:<date>` at publish. The composer's entry/invalidation/target are free text and deliberately qualitative when no price was available, so anything unparseable is dropped and that call simply gets no strip.
- **Today's** edition reads `now 12.62 · +4.8% from entry · invalidation 12.6% away`; an **archived** one reads `since this call: …`, so an old edition cannot pose as a live recommendation.
- A `?download=1` snapshot is served unfilled — never bake a live price into a file someone keeps.
- Fail-soft everywhere: a quote outage serves the paper unchanged, and an unfilled marker renders as nothing.
- The strip never echoes the ticker and the marker pattern cannot be quoted out of, so a hostile symbol reaches the page as nothing at all.

## Testing

- `shared/engine/callStatus.test.ts` — 7 tests: each state at its boundary, shorts with every sign flipped, malformed input, zero-width risk.
- `src/screens/CallNow.test.tsx` — 5 tests: the rendered strings, the chasing case, the invalidated case, a short, and rendering nothing at all before candles load.
