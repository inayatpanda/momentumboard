import { Link } from 'wouter'
import type { StreetWire } from '../../lib/api'
import { relativeStamp } from '../../lib/format'

export function ChannelCoverage({ health, onChannel }: { health: StreetWire['videoIngestion']; onChannel: (name: string) => void }) {
  if (!health?.channels) return <p className="cc-reason">Channel coverage will appear after the next feed refresh.</p>
  return <section className="channel-coverage" aria-label="Channel coverage">
    <div className="discovery-heading"><div><h2>Your channels</h2><p>Your sources for the daily reading list.</p></div><Link href="/settings">Manage →</Link></div>
    <p className="social-evidence__note">Recent discovery window: {health.discoveryWindow?.videos ?? 0} videos{health.discoveryWindow?.since ? ` · since ${new Date(health.discoveryWindow.since * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}. Counts cover this saved window, not a channel’s full history. Transcripts and analyses are separate stages.</p>
    {health.nativeRunner?.latestOnly && <p className="social-evidence__note">These are historical coverage counts. Only the daily selection is queued for new processing.</p>}
    <div className="channel-coverage__grid">{health.channels.map(channel =>
      <article className="channel-card" key={channel.id}>
        <div className="channel-card__heading"><span className="channel-card__avatar" aria-hidden="true">{channel.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span><div><h3>{channel.name}</h3><p>{(channel.feed?.latestPublishedAt ?? channel.latestPublishedAt) ? `Latest upload ${relativeStamp((channel.feed?.latestPublishedAt ?? channel.latestPublishedAt)!)}` : 'Upload date not available'}</p></div></div>
        <dl className="channel-card__counts"><div><dt>Found</dt><dd>{channel.discovered}</dd></div><div><dt>Transcripts</dt><dd>{channel.captured}</dd></div><div><dt>Analysed</dt><dd>{channel.analysed}</dd></div></dl>
        <p className="social-evidence__note">{channel.feed ? `${channel.feed.status === 'ok' ? 'Feed checked' : 'Feed unavailable · retrying'} ${relativeStamp(channel.feed.checkedAt)}` : 'Feed check not recorded yet'}</p>
        <div className="channel-card__footer"><span>{health.nativeRunner?.latestOnly ? "Included in channel rotation" : channel.awaitingCapture ? `${channel.awaitingCapture} awaiting words` : channel.awaitingAnalysis ? `${channel.awaitingAnalysis} awaiting analysis` : channel.discovered ? 'No capture backlog in this window' : channel.feed?.status === 'ok' ? 'No uploads in the recent window' : 'Discovery not confirmed yet'}</span><button type="button" onClick={() => onChannel(channel.name)}>View videos →</button></div>
      </article>,
    )}</div>
  </section>
}
