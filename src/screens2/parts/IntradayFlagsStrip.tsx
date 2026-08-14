// IntradayFlagsStrip (crypto-v2 wave, finding 8) — the morning's setups, flagged
// the moment price reaches the level, so an obvious entry gets surfaced at least
// once a day.
//
// The board slice has carried `intradayFlags` since the view split (the server
// already drops a stale blob from a prior session, and the crypto lane is
// excluded from the scan server-side), and no v2 screen consumed it — so
// deleting the legacy board at cutover would have deleted the whole live-flags
// display. Ported from src/components/EngineBoard.tsx's own IntradayFlagsStrip,
// re-dressed in v2 classes (tokens only, no inline colours).
//
// THREE STATES, and the difference between them is the honesty: nothing at all
// before the first scan of the day (silence, because nothing has been looked
// at), an explicit "scanned — nothing" once a scan has run empty, and the rows
// themselves otherwise. They are NEVER new calls: same setups, same levels, same
// sizing as the board already published.

import type { IntradayFlag, IntradayFlagsBlob } from '../../lib/api'

// the flag vocabulary, shared with the legacy Desk rail card's own copy
export const FLAG_LABEL: Record<IntradayFlag['kind'], string> = { 'entry-zone': 'entry zone', 'second-chance': 'second chance', breakout: 'breakout' }

/** Flatten a day's scans (newest scan first) into one row per symbol, freshest
 * kept — a name flagged at the open and again in power hour is one row, showing
 * the later read. */
export function flattenIntradayFlags(blob: IntradayFlagsBlob | null): IntradayFlag[] {
  if (!blob) return []
  const seen = new Set<string>()
  const out: IntradayFlag[] = []
  for (const s of blob.scans) for (const f of s.flags) if (!seen.has(f.sym)) { seen.add(f.sym); out.push(f) }
  return out
}

const flagTime = (sec: number) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })

export function IntradayFlagsStrip({ blob }: { blob: IntradayFlagsBlob | null }) {
  if (!blob || blob.scans.length === 0) return null // no scan yet — say nothing
  const flags = flattenIntradayFlags(blob)
  const lastAt = blob.scans[0]?.at
  if (flags.length === 0) {
    return <p className="cc-reason if-strip-empty">Scanned {lastAt ? flagTime(lastAt) : ''} — no clean intraday entries.</p>
  }
  return (
    <section className="if-strip" aria-label="Intraday flags">
      <p className="sec-label">Intraday flags — the morning setup at today's prices</p>
      {flags.map(f => (
        <div className="card if-row" key={`${f.sym}-${f.kind}`}>
          <div className="if-row-top">
            <span className="if-row-sym">
              <b>{f.sym}</b>
              {f.name && <span className="cc-name">{f.name}</span>}
              <span className="pill">{FLAG_LABEL[f.kind]}</span>
            </span>
            <span className="num if-row-at">flagged {flagTime(f.at)}</span>
          </div>
          <p className="cc-reason">
            <span className="num">
              {f.price} vs {f.level}
            </span>{' '}
            — {f.detail}
          </p>
        </div>
      ))}
      <p className="cc-reason">
        Not new calls — the same setups the board carries, flagged when price reaches the level intraday. No new sizing, no new levels.
      </p>
    </section>
  )
}
