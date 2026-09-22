import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { getSocialPulse, type PulseRow } from '../../lib/api'
import { getBoardSlice } from '../../lib/apiViews'
import { useSlice } from '../../lib/useSlice'
import { comparisonStatus, independentEngineRead, type ComparisonStatus } from '../../lib/socialComparison'
import { assessSocialRisk } from '../../lib/socialRisk'
import { decodeEntities } from '../../lib/format'
import { SocialStockMemory } from './SocialStockMemory'

type RadarRow = PulseRow & { capUsdM?: number | null; companyName?: string; opinion?: string }
type Filter = 'all' | ComparisonStatus | 'new' | 'multi'

const STATUS_LABEL: Record<ComparisonStatus, string> = {
  aligned: 'aligned', conflict: 'conflict', unconfirmed: 'social-only', mixed: 'YouTube split', 'no-youtube': 'no YouTube read',
}

const statusTone = (status: ComparisonStatus) => status === 'aligned' ? 'long' : status === 'conflict' ? 'short' : status === 'unconfirmed' ? 'accent' : ''
const evidenceLabel = (score?: number) => score == null ? 'evidence pending' : score >= 70 ? `strong evidence ${score}` : score >= 45 ? `moderate evidence ${score}` : `thin evidence ${score}`

function YoutubeEvidence({ row }: { row: RadarRow }) {
  const direction = row.channelNet == null ? 'No transcript evidence yet' : row.channelNet > 0 ? `Bullish net +${row.channelNet}` : row.channelNet < 0 ? `Bearish net ${row.channelNet}` : 'Creators are split'
  return (
    <div className="sr-pane">
      <span className="sr-kicker">YouTube claim</span>
      <strong>{direction}</strong>
      <span>{row.channelBreadth ?? 0} channels · {row.channelMentions ?? 0} mentions{row.channelVelocity != null ? ` · ${row.channelVelocity.toFixed(1)}× vs prior week` : ''}</span>
      {(row.channelHype ?? 0) > 0 && <span className="sr-warning">{row.channelHype} hype flag{row.channelHype === 1 ? '' : 's'}</span>}
      {(row.channelEvidence ?? []).length > 0 ? (
        <div className="sr-evidence-list">
          {row.channelEvidence.slice(0, 3).map((item, i) => (
            <a href={item.url} target="_blank" rel="noreferrer" key={`${item.url}:${i}`}>
              <span className={`pill ${item.stance === 'bull' ? 'long' : item.stance === 'bear' ? 'short' : ''}`}>{item.stance}</span>
              <b>{item.channel}</b>{item.thesis ? ` — ${item.thesis}` : ''}{item.levels.length ? ` · levels ${item.levels.join(', ')}` : ''}{item.hype ? ' · hype flagged' : ''}
            </a>
          ))}
        </div>
      ) : <span className="sr-muted">Underlying theses will appear as transcripts are processed.</span>}
    </div>
  )
}

function RadarCard({ row, board }: { row: RadarRow; board: Awaited<ReturnType<typeof getBoardSlice>> | null }) {
  const [memoryOpen, setMemoryOpen] = useState(false)
  const read = independentEngineRead(row.sym, board)
  const status = comparisonStatus(row.channelNet, read)
  const risk = assessSocialRisk(row)
  return (
    <article className="card sr-card">
      <header className="sr-card-head">
        <div>
          <Link href={`/stock/${row.sym}`} className="sr-symbol">{row.sym}</Link>
          <span className="sr-name">{decodeEntities(row.companyName ?? row.name ?? '')}</span>
        </div>
        <div className="sr-badges">
          <span className={`pill ${statusTone(status)}`}>{STATUS_LABEL[status]}</span>
          <span className={`pill sr-risk-${risk.level}`}>chase risk {risk.level}</span>
        </div>
      </header>

      <div className="sr-grid">
        <div className="sr-pane">
          <span className="sr-kicker">Social tape</span>
          <strong>{evidenceLabel(row.evidenceScore)}</strong>
          <span>{row.sources} source{row.sources === 1 ? '' : 's'} · {risk.stage}{row.observedDays != null ? ` · day ${row.observedDays}` : ''}</span>
          <span>Reddit {row.redditMentions ?? '—'} mentions{row.redditRank != null ? ` · rank #${row.redditRank}` : ''}{row.surgeMultiple != null ? ` · ${row.surgeMultiple.toFixed(1)}× 24h` : ''}</span>
          <span>Stocktwits {row.stocktwits ? 'trending' : 'not confirmed'}{row.redditUpvotes != null ? ` · ${row.redditUpvotes} Reddit upvotes` : ''}</span>
          {risk.reasons.length > 0 && <span className="sr-muted">Risk: {risk.reasons.slice(0, 3).join(' · ')}</span>}
        </div>

        <YoutubeEvidence row={row} />

        <div className="sr-pane">
          <span className="sr-kicker">Independent engine verdict</span>
          <strong>{read.summary}</strong>
          <span>{read.label} · {read.state}</span>
          {read.reasons.slice(0, 2).map((reason, i) => <span key={i}>{reason}</span>)}
          {read.risks.length > 0 && <span className="sr-warning">Challenge: {read.risks.slice(0, 2).join(' · ')}</span>}
          {(read.entry != null || read.stop != null || read.target != null) && (
            <span className="num">Entry {read.entry ?? '—'} · stop {read.stop ?? '—'} · target {read.target ?? '—'}</span>
          )}
        </div>
      </div>

      {row.opinion && <p className="sr-opinion"><b>Desk note:</b> {decodeEntities(row.opinion)}</p>}
      <footer className="sr-footer">
        <span>{status === 'aligned' ? 'Social/YouTube direction agrees with an independently active setup.' : status === 'conflict' ? 'The independent engine points against the creator consensus.' : status === 'unconfirmed' ? 'Attention exists, but price/quality evidence has not confirmed a trade.' : status === 'mixed' ? 'Creators disagree; treat the claim as unresolved.' : 'No processed YouTube claim is available yet.'}</span>
        <button type="button" className="stx-showmore" aria-expanded={memoryOpen} onClick={() => setMemoryOpen(open => !open)}>{memoryOpen ? 'Hide memory' : 'View dated memory'}</button>
      </footer>
      {memoryOpen && <SocialStockMemory symbol={row.sym} />}
    </article>
  )
}

export function SocialRadar() {
  const { data } = useSlice('intel:social', getSocialPulse)
  const { data: board } = useSlice('board', getBoardSlice)
  const [filter, setFilter] = useState<Filter>('all')
  const rows = useMemo(() => {
    if (!data) return []
    const bySym = new Map<string, RadarRow>()
    for (const row of [...data.discoveries, ...data.pulse]) bySym.set(row.sym, { ...bySym.get(row.sym), ...row } as RadarRow)
    return [...bySym.values()].sort((a, b) => (b.evidenceScore ?? 0) - (a.evidenceScore ?? 0) || (b.redditMentions ?? 0) - (a.redditMentions ?? 0))
  }, [data])
  const filtered = rows.filter(row => {
    if (filter === 'all') return true
    if (filter === 'new') return row.observedDays === 1
    if (filter === 'multi') return row.sources >= 2
    return comparisonStatus(row.channelNet, independentEngineRead(row.sym, board)) === filter
  })

  return (
    <section id="social" className="sr-section">
      <div className="sr-intro">
        <div><h2>Social Radar</h2><p>What is gaining attention, what creators actually claimed, and whether the price/quality engine confirms it independently.</p></div>
        {data && <span className="pill">{rows.length} names · updated {new Date(data.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>
      <div className="sr-filters" role="group" aria-label="Filter Social Radar">
        {([['all', 'All'], ['aligned', 'Aligned'], ['conflict', 'Conflict'], ['unconfirmed', 'Social-only'], ['mixed', 'YouTube split'], ['no-youtube', 'No YouTube'], ['new', 'New'], ['multi', 'Multi-source']] as [Filter, string][]).map(([key, label]) => (
          <button type="button" className={`pill${filter === key ? ' active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)} key={key}>{label}</button>
        ))}
      </div>
      {!data ? <div className="skeleton" style={{ height: 220 }} /> : filtered.length === 0 ? <p className="cc-reason">No names match this filter right now.</p> : <div className="sr-list">{filtered.map(row => <RadarCard row={row} board={board} key={row.sym} />)}</div>}
      <p className="sr-footnote">Attention evidence is not a probability of price appreciation. “Independent” excludes the Social Ignition sleeve to avoid circular confirmation.</p>
    </section>
  )
}
