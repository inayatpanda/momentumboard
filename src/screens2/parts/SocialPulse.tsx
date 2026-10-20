// THE SOCIAL PULSE — what the crowd is loud about.
//
// This was Intel's fifth section until the owner's review of that page: "i
// dont like the intel page which is overwhelmed by news desk." Intel is the
// news desk, the insiders and the filings; the crowd's chatter is the same
// KIND of thing the channels' videos are — other people's opinions, which the
// engine reads and does not obey — so it belongs on The street beside them.
//
// The slice key is UNCHANGED ('intel:social'): a reader who had Intel cached
// this morning keeps that data on the new page without a round trip, and the
// server route it names is the same one.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { getSocialPulse } from '../../lib/api'
import { decodeEntities, relativeStamp } from '../../lib/format'

const PAGE = 6

export function SocialPulse() {
  const { data, error, refresh, refreshing } = useSlice('intel:social', getSocialPulse)
  const [visible, setVisible] = useState(PAGE)
  const rows = data?.pulse ?? []

  return (
    <section id="social" className="card itl-section">
      <h2 className="sec-label">Social pulse</h2>
      <p className="social-evidence__note">Attention across tracked sources. More mentions measure interest, not business quality or expected returns.{data?.at ? ` Updated ${relativeStamp(data.at)}.` : ''}</p>
      {error && <div role="alert"><p className="cc-reason">{data ? 'The latest update failed. Showing the last saved pulse.' : 'Social activity could not be loaded.'}</p><button className="stocks-text-link" onClick={refresh} disabled={refreshing}>Retry social activity</button></div>}
      {!data && !error ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : !data ? null : rows.length === 0 && data.alsoLoud.length === 0 && data.discoveries.length === 0 ? (
        <p className="cc-reason">Nothing loud enough to show right now.</p>
      ) : (
        <>
          {data.alsoLoud.length > 0 && (
            <div className="itl-loud-row">
              <span>Also loud:</span>
              {data.alsoLoud.map(s => (
                <Link key={s} href={`/stock/${s}`} className="pill">
                  {s}
                </Link>
              ))}
            </div>
          )}
          {data.discoveries.length > 0 && (
            <div className="itl-discoveries">
              {data.discoveries.slice(0, 5).map(d => (
                <Link key={d.sym} href={`/stock/${d.sym}`} className="card pressable itl-discovery">
                  <span className="itl-pulse-sym">{d.sym}</span>
                  {/* the pulse's names arrive from the same feeds the news desk
                      reads, entities and all — "SPDR S&amp;P 500 ETF Trust" was
                      on screen (visibility wave). Same decode the desk uses. */}
                  {d.companyName && <span className="itl-pulse-name">{decodeEntities(d.companyName)}</span>}
                  {d.opinion && <p className="cc-reason">{decodeEntities(d.opinion)}</p>}
                </Link>
              ))}
            </div>
          )}
          <div className="itl-pulse-list">
            {rows.slice(0, visible).map(r => (
              <Link key={r.sym} href={`/stock/${r.sym}`} className="card pressable itl-pulse-row">
                <span className="itl-pulse-sym">{r.sym}</span>
                {r.name && <span className="itl-pulse-name">{decodeEntities(r.name)}</span>}
                <span className="itl-pulse-meta">
                  {r.redditMentions != null && <span className="num">{r.redditMentions} Reddit mentions</span>}
                  {r.stocktwits && <span>Stocktwits trending</span>}
                  {r.surging && <span className="pill accent">surging{r.surgeMultiple != null ? ` ${r.surgeMultiple.toFixed(1)}x` : ''}</span>}
                </span>
              </Link>
            ))}
          </div>
          {visible < rows.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(rows.length)}>
              Show more ({rows.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}
