// THE ROUTED ANALYTICS SCREEN'S CONTENTS — the four quant panels the retired
// Quant screen used to deck out. The route is lazy, so a reader who never opens
// Analytics pays neither its component bytes nor its data requests.
//
// DATA — every panel is fed through `useSlice`, never a bare fetch, so the
// screen paints from Dexie first and shares the board/learning slices the rest
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
  // the SAME key Research2 reads (it was 'events' here and 'research:events'
  // there): two keys over one fetcher is two Dexie rows, two TTL clocks and two
  // network trips for one answer
  const { data: dossiers } = useSlice('research:events', getEventDossiers)

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
      <details className="company-detail"><summary>See the evidence: the market outlook</summary><LeanPanel
        board={board?.board ?? null}
        calibration={calibration}
        vixChangePct={vix?.quote?.changePct ?? null}
        analogue={analogueDossier?.analogues ?? null}
        analogueSym={analogueDossier?.sym}
      />
      </details>
      <details className="company-detail"><summary>See the evidence: prediction accuracy</summary><LearningPanel calibration={calibration} weights={weights} /></details>
      <details className="company-detail"><summary>See the evidence: seasonal market patterns</summary><SeasonalityPanel data={season ?? null} /></details>
      <details id="funds" open={typeof window !== 'undefined' && window.location.hash === '#funds'} className="company-detail"><summary>See the evidence: what funds hold</summary><SmartMoneyPanel data={smart ?? null} /></details>
    </div>
  )
}
