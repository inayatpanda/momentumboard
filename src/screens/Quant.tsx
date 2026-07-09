import { useEffect, useState } from 'react'
import {
  getEngine,
  getSectors,
  getQuotes,
  getCandles,
  getSeasonality,
  getSmartMoney,
  getEventDossiers,
  type EngineData,
} from '../lib/api'
import { humanError } from '../lib/format'
import { IconGear } from '../components/icons'
import { LeanPanel } from '../components/quant/LeanPanel'
import { SectorHeatmap } from '../components/quant/SectorHeatmap'
import { LearningPanel } from '../components/quant/LearningPanel'
import { SeasonalityPanel } from '../components/quant/SeasonalityPanel'
import { SmartMoneyPanel } from '../components/quant/SmartMoneyPanel'

// THE QUANT COCKPIT: a wide, full-bleed data-viz deck built entirely from data
// the app already fetches. Five panels — an honest next-day lean, a sector
// sentiment heatmap, the engine's learning curves, SPY seasonality, and 13F
// smart-money flow — laid out in a fluid grid from 14" laptops up to 27"
// monitors. Every source loads in parallel (allSettled), so one dead endpoint
// degrades a single panel instead of blanking the screen.

type Sectors = Awaited<ReturnType<typeof getSectors>>
type Quotes = Awaited<ReturnType<typeof getQuotes>>
type Seasonality = Awaited<ReturnType<typeof getSeasonality>>
type SmartMoney = Awaited<ReturnType<typeof getSmartMoney>>
type Dossiers = Awaited<ReturnType<typeof getEventDossiers>>

export function Quant({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  const [engine, setEngine] = useState<EngineData | null>(null)
  const [sectors, setSectors] = useState<Sectors | null>(null)
  const [quotes, setQuotes] = useState<Quotes>([])
  const [vixChangePct, setVixChangePct] = useState<number | null>(null)
  const [season, setSeason] = useState<Seasonality | null>(null)
  const [smart, setSmart] = useState<SmartMoney | null>(null)
  const [dossiers, setDossiers] = useState<Dossiers | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    // sector day %changes depend on the sector roster, so quotes chain off the
    // sectors call — but both promises still ride the same allSettled batch.
    const sectorsP = getSectors()
    const quotesP = sectorsP.then(s => getQuotes(s.rows.map(r => r.sym)))
    Promise.allSettled([
      getEngine(),
      sectorsP,
      quotesP,
      getCandles('^VIX'),
      getSeasonality('SPY'),
      getSmartMoney(),
      getEventDossiers(),
    ]).then(([engR, secR, qR, vixR, seasR, smR, dosR]) => {
      setEngine(engR.status === 'fulfilled' ? engR.value : null)
      setSectors(secR.status === 'fulfilled' ? secR.value : null)
      setQuotes(qR.status === 'fulfilled' ? qR.value : [])
      setVixChangePct(vixR.status === 'fulfilled' ? vixR.value.quote?.changePct ?? null : null)
      setSeason(seasR.status === 'fulfilled' ? seasR.value : null)
      setSmart(smR.status === 'fulfilled' ? smR.value : null)
      setDossiers(dosR.status === 'fulfilled' ? dosR.value : null)

      const results = [engR, secR, qR, vixR, seasR, smR, dosR]
      if (results.every(r => r.status === 'rejected')) {
        const firstRej = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
        setError(humanError(firstRej?.reason))
      }
      setLoading(false)
    })
  }

  useEffect(load, [])

  if (loading && !engine && !sectors) {
    return (
      <div className="desk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh' }}>
        <p className="empty-line">Loading the quant deck…</p>
      </div>
    )
  }

  if (error && !engine && !sectors) {
    return (
      <div className="desk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh' }}>
        <p className="empty-line">The quant deck couldn't load — {error}.</p>
      </div>
    )
  }

  const analogueDossier = dossiers?.find(d => d.analogues) ?? null

  return (
    <div className="desk">
      <header className="desk-top">
        <span className="desk-brand">
          The Street Signal <span>Quant</span>
        </span>
        <span className="desk-spacer" />
        <button className="mini-btn ghost" onClick={load}>Refresh</button>
        <button className="mini-btn ghost" onClick={onBack}>Desk</button>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>

      <div className="quant-grid">
        <LeanPanel
          board={engine?.board ?? null}
          calibration={engine?.calibration ?? null}
          vixChangePct={vixChangePct}
          analogue={analogueDossier?.analogues ?? null}
          analogueSym={analogueDossier?.sym}
        />
        <SectorHeatmap sectors={sectors} quotes={quotes} />
        <LearningPanel calibration={engine?.calibration ?? null} weights={engine?.weights ?? null} />
        <SeasonalityPanel data={season} />
        <SmartMoneyPanel data={smart} />
      </div>
    </div>
  )
}
