# Research components reviewed and adapted

StreetSignal adapts the sparse, filing-anchored forward-fill approach from
`HKUDS/Vibe-Trading`, commit `90819468a50219a936c92df5e3d12c12a56b159e`,
`agent/backtest/loaders/fundamentals_loader.py::_ffill_pit`, in
`scripts/lib/historicalFundamentals.ts::financialPointAt`.
Copyright 2026 Vibe-Trading Contributors / HKUDS contributors.
The complete MIT licence is in `Vibe-Trading-LICENSE.txt` beside this document.
This includes software developed at HKUDS (https://github.com/HKUDS).

The adaptation uses StreetSignal's existing USD/US-GAAP accounting parser and
adds a conservative next-day-noon UTC publication delay, date-expiry checks,
historical share observations, and split-consistent valuation. Annual flows
are intentionally labelled annual: we do not import upstream's approximate
TTM synthesis, mixed-unit extraction, or call a post-hoc time-window split a
train/test walk-forward experiment. No Python runtime or AI service is added.
Qlib factors, fonts, broker connectors and trading agents are not bundled.

Sources:
- https://github.com/HKUDS/Vibe-Trading/blob/90819468a50219a936c92df5e3d12c12a56b159e/agent/backtest/loaders/fundamentals_loader.py
- https://github.com/HKUDS/Vibe-Trading/blob/90819468a50219a936c92df5e3d12c12a56b159e/LICENSE
- https://www.sec.gov/search-filings/edgar-application-programming-interfaces

## Fincept

Reviewed FinceptTerminal's current README and LICENSE on 21 October 2026.
It describes a broad desktop financial terminal, but the licence file adds
commercial/internal/hosted-use restrictions to its AGPL label. We have not
copied or bundled its code, branding, layout, APIs or data. StreetSignal's
strategy/sector comparison views are independently implemented common
financial-analysis functionality. No Fincept subscription is required.

https://github.com/Fincept-Corporation/FinceptTerminal/blob/main/LICENSE

## Fixed experiment specification

Before inspecting the new results: keep the existing 22-stock survivor panel,
2020-onward evaluation, next-open entry, 10bp/side friction on both stock and
SPY, adjusted-return outcomes and non-overlap within a stock/strategy.
Add five predeclared comparisons: big-drop price control (20–60% below
252-session highest close with rising SMA20 reclaim), same plus sector health,
same plus health and annual valuation, trend control plus health, and health
plus annual valuation without a price trigger. Holds are 63 sessions except
quality momentum (20). All four financial tests use existing versioned sector
policies, unmodified by the results. Preserve all nine strategies and adjust
uncertainty for all nine. Sector tables are descriptive only. Missing data
and specialist sectors do not pass the screen. Fixed rules selected now are
retrospective hypotheses, not untouched holdout evidence or a replay of the
full news-aware live strategy. No historical simulation enters the live ledger.
