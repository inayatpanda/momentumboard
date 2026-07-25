# Where is the price now? — call status on the board

**Date:** 2026-07-25
**Status:** implemented (board); paper strip deferred

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

## Deferred: the paper strip

The report is static HTML that also becomes the PDF, so live prices there need a client-side fetch and a read-only quote route. Deferred until the board version has been used.

One decision made in advance: in **today's** edition this should read as a live price, but in an **archived** edition it must read as *outcome* ("since this call: +4.8%, invalidation never hit") — otherwise a two-week-old edition looks like it is still recommending something.

## Testing

- `shared/engine/callStatus.test.ts` — 7 tests: each state at its boundary, shorts with every sign flipped, malformed input, zero-width risk.
- `src/screens/CallNow.test.tsx` — 5 tests: the rendered strings, the chasing case, the invalidated case, a short, and rendering nothing at all before candles load.
