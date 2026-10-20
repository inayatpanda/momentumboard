import { stripEmoji } from '../../components/icons'
import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { getStreetWire } from '../../lib/api'
import { relativeStamp } from '../../lib/format'
import { latestStreetVideos } from '../../lib/socialFeed'
import { ClaimEvidence } from './SocialEvidence'

/** This is a recent-source window, not a claim to search the channel archive. */
export function CompanySources({ symbol }: { symbol: string }) {
  const { data, error, refresh, refreshing } = useSlice('street:wire', getStreetWire)
  const videos = latestStreetVideos(data?.videos ?? []).filter(v => v.tickers.some(t => t.sym === symbol) || v.claims?.some(c => c.sym === symbol)).slice(0, 5)
  return <section className="company-sources card" aria-label="Recent channel evidence">
    <div className="discovery-heading"><div><p className="stocks-eyebrow">FROM YOUR CHANNELS</p><h2>What’s being said</h2></div><Link href={`/more/street?stock=${encodeURIComponent(symbol)}`}>View feed ↗</Link></div>
    <p className="cc-reason">{symbol} mentions in the latest {data?.videos.length ?? 30} analysed videos. Creator views are separate from the engine’s investment case.</p>
    {error && <p role="status">Channel evidence could not refresh. <button onClick={refresh} disabled={refreshing}>Retry channels</button></p>}
    {!data && !error ? <p role="status">Checking your channels…</p> : !videos.length ? <p className="company-empty">No {symbol} mentions in this recent window. This does not mean your channels have never covered it.</p> : videos.map(video => {
      const mentions = video.tickers.filter(t => t.sym === symbol)
      return <article key={video.url} className="company-source">
        <div className="company-source-meta"><strong>{video.channel}</strong><span>{relativeStamp(video.at)}</span></div>
        <a href={video.url} target="_blank" rel="noreferrer">{stripEmoji(video.title)} ↗</a>
        {video.nativeTranscript && <p className="social-evidence__note">AI video interpretation · {video.nativeTranscript.progress?.completion === 'complete' ? 'all sections processed' : 'full coverage unconfirmed'} · source check pending</p>}
        {mentions.map(t => <p key={t.sym} className="cc-reason"><span className={`pill ${t.stance === 'bull' ? 'long' : t.stance === 'bear' ? 'short' : ''}`}>{t.stance === 'bull' ? 'Bullish' : t.stance === 'bear' ? 'Bearish' : 'Neutral'}</span> {t.thesis || 'Mentioned in this video; a specific investment case was not captured.'}</p>)}
        <details className="company-detail"><summary>View supporting evidence</summary><ClaimEvidence video={{ ...video, claims: video.claims?.filter(c => c.sym === symbol) }} />{!video.claims && <p className="cc-reason">This older analysis has no saved source quotations.</p>}</details>
      </article>
    })}
  </section>
}
