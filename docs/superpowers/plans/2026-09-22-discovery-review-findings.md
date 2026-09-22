# Discovery engine v2 — adversarial review findings (2026-09-22, Opus reviewer)

Verdict FIX-FIRST. Minimal set before live: #1+#2, #3, #4, #8; then #5/#6/#7 before trusting LSE output; #9 before first cold run.

1. HIGH roster flood/eviction — engine.ts ~1866 lets scan picks (capUsdM null → sorts last in the largest-cap-first trim) join `updateRoster`; ~87/day joiners evict earned members. Fix: exclude scan-only names from rosterCandidates (they reach scoring via evalRows).
2. HIGH `scan:<lens>` persisted as roster source → replayed before the scan door → `scanOnly()` true forever → last in cap queue → cohort unknown for ever. Fixed by #1; also key scanOnly on scanSet, not the string.
3. HIGH discoveryTapes (300 bars) replace cachedCandles (252) for ALL universe names → swingCapacity/patternScore inputs change for every board name when DISCOVERY turns on. Fix: slice(-252), or reuse tapes only for scanSet.
4. MED-HIGH capBand 'large' ≠ >$10B (smallest sp500/ndx/ftse100 members $3–8B). Fix: restrict the dip-quality band shortcut (e.g. sp500+ftse100 only when cap unknown) and fix the comment.
5. MED 8 LSE seed rows quote in USD/EUR (CPG.L, IHG.L…) — pence divisor keyed on exchange, not currency. Fix: key on row.currency === 'GBp'.
6. MED Easter Tuesday: LSE stale by 3.05 sessions (calendar×5/7) → all 350 LSE rejected. Fix: 4 sessions or per-exchange staleness.
7. MED SPY alignment compares raw exchange-open timestamps (07:00 UTC .L vs 13:30 SPY) → never matches → always index fallback. Fix: compare UTC day.
8. MED budget-cut symbol served from cache still listed in `unread`, counted in barsFailed AND barsFromCache; index.ts checks unread before tapes. Fix: drop from unread when tapes.has(sym).
9. MED DISCOVERY_MAX_REQUESTS 2,500 vs worst case 2,466 + retries. Fix: 3,500 or don't count retries.
10. LOW unusual sentence prints unfloored typical-day figure. Print floored.
11. LOW no seed-size floor vs committed count (refuse < 85%).
12. LOW byte-identity test is self-referential; trimmed detail string changed vs main. Pin both strings literally.
13. LOW stooq.ts returns null on any '-' so BRK-B/BF-B never fall back.
14. LOW 6 of 9 PERCENTILE_FIELDS unread by any lens (wasted sorts).
