import { StockIdentity } from '../../components/StockIdentity'
import { useState } from 'react'
import { Link } from 'wouter'
import type { StreetVideo, StreetWire } from '../../lib/api'
import { retrySocialJob } from '../../lib/api'
import { relativeStamp } from '../../lib/format'
import { canonicalVideoUrl } from '../../../shared/youtubeCaptions.mjs'
import '../../styles/social-evidence.css'

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp`

export function ClaimEvidence({ video }: { video: StreetVideo }) {
  if (!video.claims) return null
  const qualified = video.claims.filter(c => c.sourceMatch === 'matched' && c.identityMatched)
  const coverage = video.coverage
  return <div className="social-evidence">
    <div className="social-evidence__coverage">
      <span>{qualified.length} sourced {qualified.length === 1 ? 'claim' : 'claims'}</span>
      {coverage && <span>{video.nativeTranscript ? 'AI transcription · source check pending' : coverage.chunks > 0 ? `${coverage.analysedChunks}/${coverage.chunks} transcript sections read${coverage.complete ? '' : ' · partial'}` : 'Transcript unavailable'}</span>}
      {coverage && <span>{coverage.timedSegments > 0 ? `${coverage.timedSegments}/${coverage.totalSegments} caption segments timed` : 'No source timestamps'}</span>}
    </div>
    <p className="social-evidence__note">{coverage?.visual === 'model-reviewed-unverified' ? 'Video model output. Visual details remain unverified.' : 'Spoken words analysed. Charts have not been checked.'}</p>
    {video.publishedAt && <p className="social-evidence__note">Published {relativeStamp(video.publishedAt)} · Available in the app {relativeStamp(video.at)}</p>}
    {video.claims.length === 0 && <p className="cc-reason">No specific claims could be extracted from this source.</p>}
    {video.claims.map(claim => {
      const sourced = claim.sourceMatch === 'matched' && claim.identityMatched
      const canonical = canonicalVideoUrl(video.url)
      const timestampUrl = canonical && claim.startSec != null ? `${canonical}&t=${Math.floor(claim.startSec)}s` : null
      return <details className="social-claim" key={claim.id}>
        <summary>
          <span className="social-claim__identity"><StockIdentity symbol={claim.sym} /> <span>{claim.stance === 'bull' ? 'Expecting a rise' : claim.stance === 'bear' ? 'Expecting a fall' : 'No clear direction'}</span></span>
          <span className={`social-claim__badge ${sourced ? 'is-sourced' : ''}`}>{sourced ? 'Quote matched' : 'Needs source check'}</span>
        </summary>
        <p>{claim.rationale || 'Source excerpt only.'}</p>
        {claim.quote && <blockquote>{claim.quote}</blockquote>}
        {timestampUrl ? <a className="social-claim__jump" href={timestampUrl} target="_blank" rel="noreferrer">Play source at {stamp(claim.startSec!)} ↗</a> : <p className="social-evidence__note">No reliable timecode for this claim.</p>}
        <dl className="social-claim__facts">
          <div><dt>Creator’s timeframe</dt><dd>{claim.horizon || 'Not explicitly captured'}</dd></div>
          <div><dt>Condition</dt><dd>{claim.condition || (claim.unconditional ? 'No condition stated in the quoted view' : 'Unclear — excluded from outcome tracking')}</dd></div>
          <div><dt>Fact check</dt><dd>{claim.verification.status === 'supported' ? 'Cited numerical facts supported' : claim.verification.status === 'contradicted' ? 'Conflicting filing evidence' : 'Not independently verified'}</dd></div>
        </dl>
        {claim.levels.length > 0 && <p className="cc-reason">Stated levels: {claim.levels.map(l => `${l.kind} ${l.value}`).join(' · ')}. These are the creator’s levels, not validated support or trade instructions.</p>}
        {claim.verification.checks.map((check, i) => <p className="social-evidence__note" key={i}>{check.detail} {check.sourceUrl && <a href={check.sourceUrl} target="_blank" rel="noreferrer">Filing evidence ↗</a>}</p>)}
      </details>
    })}
  </div>
}

const stageNames: Record<string, string> = { queued: 'Queued', captions: 'Finding captions', 'waiting-provider': 'Transcript provider working', extracting: 'Reading transcript sections', verifying: 'Checking cited facts', publishing: 'Saving evidence', complete: 'Complete', 'needs-attention': 'Needs attention' }

export function ProcessingJobs({ health, onRefresh }: { health: NonNullable<StreetWire['videoIngestion']>; onRefresh?: () => unknown }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const retry = async (id: string) => {
    setBusy(id); setMessage('')
    try { await retrySocialJob(id); setMessage('Queued for the next worker run. Existing evidence is preserved.'); onRefresh?.() }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Retry failed.') }
    finally { setBusy(null) }
  }
  return <>
    {health.workerStale && <p className="social-evidence__warning">The analysis worker has not checked in within six hours. Pending videos are retained.</p>}
    {!!health.jobs?.length && <details className="social-processing">
      <summary>Follow individual videos ({health.jobs.length} shown)</summary>
      <ol>{health.jobs.map(job => <li key={job.id}>
        <div><b>{job.title || 'Untitled video'}</b><span>{stageNames[job.stage] ?? 'Processing'} · {job.mode === 'watch' ? 'Detailed review' : 'Finding stock claims'}</span></div>
        <p>{job.reason?.replace(/-/g, ' ') || 'Waiting for the next processing step.'} · {job.attempts} failed attempts</p>
        {job.stage === 'needs-attention' && <button type="button" disabled={busy != null} onClick={() => retry(job.id)}>{busy === job.id ? 'Queuing…' : 'Retry (owner)'}</button>}
      </li>)}</ol>
    </details>}
    {message && <p role="status" className="cc-reason">{message}</p>}
  </>
}

export function SocialLearning({ learning }: { learning: StreetWire['socialLearning'] }) {
  if (!learning) return null
  return <section className="card itl-section social-learning" aria-label="Social evidence learning">
    <div className="social-learning__heading"><h2 className="sec-label">Does the evidence hold up?</h2><span className="social-claim__badge">Following new predictions</span></div>
    <p className="cc-reason">We follow clear stock predictions from your channels and compare their results with the US market. Each test lasts 10 trading days.</p>
    <div className="social-learning__stats">
      <div><b>{learning.pending}</b><span>Awaiting outcomes</span></div>
      <div><b>{learning.independent}</b><span>Separate results</span></div>
      <div><b>{learning.repeats}</b><span>Repeated ideas</span></div>
    </div>
    <details className="social-processing"><summary>See the evidence: how channel results are tested</summary><p>Comparisons start at the next market open and include estimated trading costs of 0.20% in total.</p><p className="social-evidence__note">This common 10-session yardstick is not the creator’s stated horizon. It does not change position sizes or channel weights. Publication-time results are retrospective; app-time results start only after capture. Borrow costs and dividends are excluded. Differences are measured in percentage points.</p></details>
    {learning.channels.length > 0 && <div className="social-table-wrap"><table className="social-learning__table"><thead><tr><th>Channel</th><th>Independent calls</th><th>Beat the market</th><th>Avg difference</th></tr></thead><tbody>
      {learning.channels.map(c => <tr key={c.channel}><td>{c.channel}</td><td>{c.n}</td><td>{c.hits}/{c.n}</td><td>{signed(c.averageExcessPct)}</td></tr>)}
    </tbody></table></div>}
    {learning.recent.length > 0 ? <details className="social-processing"><summary>See the evidence: predictions and results</summary><ul>{learning.recent.map(row => <li key={row.id}>
      <div><Link href={`/stock/${row.sym}`}><b><StockIdentity symbol={row.sym} /></b></Link><span>{row.channel}{row.repeated ? ' · Repeat campaign' : ''}</span></div>
      <p>App-time: {row.app ? signed(row.app.excessPct) : 'pending'} · Publication-time: {row.creator ? signed(row.creator.excessPct) : row.publishedAt ? 'pending' : 'unknown publication date'}</p>
      <a href={row.sourceUrl} target="_blank" rel="noreferrer">Original source ↗</a>
    </li>)}</ul></details> : <p className="social-evidence__note">The study begins with newly captured, source-matched claims. Old summaries are not assigned invented historical evidence.</p>}
  </section>
}
