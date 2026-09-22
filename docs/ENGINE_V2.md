# StreetSignal engine v2

StreetSignal now separates the existing calibrated engine from new predictive strategy sleeves. New sleeves begin in **shadow mode**: visible in the app, timestamped and graded, but unable to size or route a trade.

## Forecast contracts

- The existing Board probability is labelled `edge p`. It means: beat SPY by at least 1 percentage point over 10 sessions without a daily close through the published stop.
- The 3-Session Forecast asks whether the third session will close above or below the signal-day close. Its initial up/down odds and expected range come from the closest point-in-time historical states in that symbol's own tape. Historical-analogue count and forward StreetSignal evidence are shown separately.
- New sleeve forecasts ask a different, execution-oriented question: does the target trade before the stop within the stated horizon?
- Target and stop probabilities remain blank (`collecting`) until that sleeve has out-of-sample campaigns. A score is a ranking feature, not a probability.

## Independent campaigns

A daily refresh of the same symbol, side and setup is not new evidence. Every publication keeps its dated `id`, but overlapping refreshes share the first row's `campaignId`. Only the campaign owner updates calibration, factor learning, Brier score and risk ladders.

## Strategy sleeves

### 3-Session Forecast

Runs independently from the 10-session Board. It compares the current one-, three- and ten-session returns, RSI, distance from the ten-session mean, recent volatility and volume to historical states, then measures the following three-session outcome. A setup requires at least 60% directional frequency and a confirming median move; otherwise the app says `NO EDGE` instead of forcing a call. GOOG and GOOGL are evaluated every run even when neither is in a mover or social feed. Every displayed forecast is logged for forward grading, including no-edge forecasts, while only directional setups receive research stop/target levels.

### Quality Dip Recovery

Looks for an 8–45% drawdown in a curated core/large-cap quality proxy, then requires early price stabilisation. It explicitly flags falling knives and weak relative strength. It cannot graduate from shadow mode until point-in-time cash flow, leverage, estimate-revision and dilution data are connected.

### Social Ignition

Ranks source agreement, 24-hour Reddit acceleration, acceleration between StreetSignal scans, StockTwits presence and YouTube direction. Extreme acceleration in a sub-$500m single-source name is treated as promotion/pump risk, not a buy signal. Unique-author, engagement-quality and coordinated-promotion features remain named data gaps until source-level feeds are connected.

### Macro/Event Transmission

Visible as `collecting`. It must have timestamped surprise data and point-in-time company exposure maps before it can audition predictions.

## Promotion rule

Each new sleeve needs at least 40 independent campaigns, positive expectancy after execution costs, acceptable drawdown and a useful calibration curve. A sleeve is promoted by evidence, not by a few spectacular winners.

## Execution book v2

- A new call queues on signal day and fills at the next session open.
- Entry and exits include 10bp adverse slippage; commission is currently modelled at £0 and stated in the app.
- Position size uses the actual fill-to-stop distance.
- Stop and target use daily high/low. If both trade in one daily bar, the stop is booked first.
- Gaps outside the published stop-to-target geometry cancel the order.
- Long and short risk permissions learn separately; a profitable short record cannot finance long risk.

## What the app shows

Signals → Markets contains the Engine Lab with sleeve status, evidence count, setup/watch/avoid state, scan time, reasons, risks, data gaps and forecast definition. The 3-Session cards expose up/down odds, no-edge state, expected move/range, historical analogue count, matured live count, live direction accuracy and target-before-stop evidence. Research → Ledger shows directional risk rungs and the execution book's pending next-open orders and fill policy.
