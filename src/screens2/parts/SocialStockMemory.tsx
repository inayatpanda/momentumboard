import { stripEmoji } from '../../components/icons'
import { useSlice } from '../../lib/useSlice'
import { getSocialMemory } from '../../lib/api'

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

export function SocialStockMemory({ symbol }: { symbol: string }) {
  const { data } = useSlice(`social-memory:${symbol}`, () => getSocialMemory(symbol))
  if (!data) return <div className="skeleton" style={{ height: 96 }} aria-label={`Loading ${symbol} social memory`} />
  if (!data.length) return <p className="cc-reason">No dated history yet. Today’s observation will become the first memory after the social collector completes.</p>
  return (
    <div className="sr-memory-list" aria-label={`${symbol} social memory`}>
      {data.map(day => (
        <article className="sr-memory-day" key={day.date}>
          <div className="sr-memory-head">
            <strong>{dateLabel(day.date)}</strong>
            {day.metrics.evidenceScore != null && <span className="pill">evidence {day.metrics.evidenceScore}/100</span>}
          </div>
          <p>{day.summary}</p>
          {day.youtube.length > 0 && (
            <div className="sr-memory-links">
              {day.youtube.map(video => (
                <a href={video.url} target="_blank" rel="noreferrer" key={`${video.url}:${video.at}`}>
                  <span className={`pill ${video.stance === 'bull' ? 'long' : video.stance === 'bear' ? 'short' : ''}`}>{video.stance}</span>
                  {video.channel}: {stripEmoji(video.title)}{video.levels.length ? ` · levels ${video.levels.join(', ')}` : ''}{video.hype ? ' · hype flagged' : ''}
                </a>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  )
}
