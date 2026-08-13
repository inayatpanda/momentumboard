// RETIRED 2026-08-13 — superseded by `scripts/replay-window.ts --seed-out`.
//
// This script fetched 2y of Yahoo candles for 66 sector names and handed them to
// `seedFromHistory` (shared/engine/backtest.ts), which drove `composeCall` over a
// bare symbol × every-5th-bar grid and wrote `shared/engine/seed.json`. The file is
// kept — not deleted — because the stage-2b spec (§4.4) names it by path, and a
// pointer that resolves is worth more than a broken reference.
//
// WHY IT IS RETIRED. §4.4 asks the seed to be measured by "all lanes, the sleeve,
// the roster, the screens and the world-tape tone". This seeder has NONE of them:
// no dip lane, no velocity lane, no core sleeve, no roster, no screens, no
// world-tape multiplier, no near-misses, no setup families beyond what composeCall
// stamps — and a hand-rolled twin of `gradePrediction` that has to be kept in step
// with the real one by hand. Every one of those already exists in
// `scripts/replay-window.ts`, which drives the REAL `gradeOutstanding → buildBoard`
// day by day against a carrying store, with strict point-in-time slicing. Expanding
// this file to meet §4.4 would have meant re-implementing that harness, worse.
//
// The two also measure DIFFERENT POPULATIONS, and that is the substantive part of
// the decision rather than a matter of code reuse: this seeder sampled every call
// that cleared the gates for every name on every fifth bar, while the walk samples
// only what `buildBoard` actually published. The walk's population is the one live
// grading measures, which is the population a calibration curve is supposed to
// describe. It is also the one that can reach the 70+ band at all — a board
// publishes its best, a sweep publishes everything.
//
// THE SUCCESSOR:
//   npx tsx scripts/replay-window.ts --from <ISO> --to <ISO> \
//     --seed-out shared/engine/seed.json.candidate --seed-generation <n>
// It emits the same `{ generatedAt, symbols, weights, calibration }` shape with the
// stamps this seeder never wrote: an explicit `modelVersion` (the committed file
// still says 2 only because `seedFromHistory` left the field unset and
// `migrateCalibration` backfilled whatever the constant was on the day), and a
// `seedGeneration` — the channel `loadState` uses to install a regenerated seed at
// an unchanged `CALIB_DEF_VERSION`. See replay-window.ts's header, "FIFTH MODE".
//
// `shared/engine/backtest.ts` itself is NOT retired. `seedFromHistory` remains the
// reference implementation of the hit definition — its grading twin is deliberately
// line-for-line with `gradePrediction`, and its test is one of the things that would
// notice if the two drifted apart.

export {}

throw new Error(
  'scripts/seed-engine.ts is retired. The deep seed is emitted by the walk that measures it:\n' +
    '  npx tsx scripts/replay-window.ts --from <ISO> --to <ISO> --seed-out <path> --seed-generation <n>\n' +
    'See the comment at the top of this file for why, and replay-window.ts\'s header for how.',
)
