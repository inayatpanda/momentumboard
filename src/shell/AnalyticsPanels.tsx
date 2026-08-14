// THE ANALYTICS DRAWER'S CONTENTS (plan Task 22; spec §3.8) — the four quant
// panels the retired Quant screen used to deck out (src/screens/Quant.tsx),
// stacked in the desk's right slide-over. Desktop only, and LAZY: this module
// is imported only when the drawer opens, so neither a phone nor a desktop
// reader who never opens it pays a byte or a request for it.
//
// DATA — every panel is fed through `useSlice`, never a bare fetch, so the
// drawer paints from Dexie first and shares the board/learning slices the rest
// of the shell already has warm. All six sources are cutover-safe: `board` and
// `learning` are the new view slices, and seasonality / smart-money / candles /
// event-dossiers are /api/market and /api/config endpoints that survive the
// cutover (only the legacy `/api/engine` aggregate and T212 are retired).

import { useSlice } from '../lib/useSlice'
import { getBoardSlice, getLearning } from '../lib/apiViews'
import { getCandles, getEventDossiers, getSeasonality, getSmartMoney, type EngineData } from '../lib/api'
import { LeanPanel } from '../components/quant/LeanPanel'
import { SeasonalityPanel } from '../components/quant/SeasonalityPanel'
import { SmartMoneyPanel } from '../components/quant/SmartMoneyPanel'
import { LearningPanel } from '../components/quant/LearningPanel'

type Calibration = NonNullable<EngineData['calibration']>
type Weights = NonNullable<EngineData['weights']>

export default function AnalyticsPanels() {
  const { data: board } = useSlice('board', getBoardSlice)
  const { data: learning } = useSlice('learning', getLearning)
  const { data: season } = useSlice('seasonality:SPY', () => getSeasonality('SPY'))
  const { data: smart } = useSlice('smart-money', getSmartMoney)
  const { data: vix } = useSlice('candles:^VIX:1y', () => getCandles('^VIX', '1y'))
  const { data: dossiers } = useSlice('events', getEventDossiers)

  // ONE server projection (netlify/functions/engine.mts `projectCalibration`)
  // feeds both `?view=learning` and the legacy aggregate; the aggregate's
  // client type names the bucket/brier shapes precisely and `LearningSlice`
  // types them loosely (`unknown`). Same bytes — narrowed here rather than by
  // widening a shared type another screen depends on (the precedent is
  // src/screens2/Record.tsx:69's identical bucket cast).
  const cal = learning?.calibration
  const calibration: Calibration | null = cal
    ? {
        buckets: cal.buckets as Calibration['buckets'],
        brier: cal.brier as Calibration['brier'],
        seeded: cal.seeded,
        referenceBase: cal.referenceBase,
      }
    : null
  const w = learning?.weights
  const weights: Weights | null = w ? { base: w.base, current: w.current, history: w.history as Weights['history'] } : null

  // the analogue line: the newest event dossier that actually measured priors
  const analogueDossier = dossiers?.find(d => d.analogues) ?? null

  return (
    <div className="desk2-panels">
      <LeanPanel
        board={board?.board ?? null}
        calibration={calibration}
        vixChangePct={vix?.quote?.changePct ?? null}
        analogue={analogueDossier?.analogues ?? null}
        analogueSym={analogueDossier?.sym}
      />
      <LearningPanel calibration={calibration} weights={weights} />
      <SeasonalityPanel data={season ?? null} />
      <SmartMoneyPanel data={smart ?? null} />
    </div>
  )
}
