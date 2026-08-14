// FactorVotes (plan Task 17) — every factor's signed vote as a bar growing
// from a centre line: right of centre for a positive contribution, left for a
// negative one, length proportional to the biggest vote on the page.
//
// COLOUR RULE: the bars are INDIGO ONLY (--accent-bar / --accent-soft). Green
// and red are reserved for direction and P&L — a factor voting "down" is not
// a loss, and painting it red would teach the reader otherwise. Direction is
// carried by which SIDE of the centre line the bar sits on, plus its signed
// number.
//
// A factor that could not score is not a zero vote — it is an absence, and it
// is named as one ("no data: news tone, social") rather than drawn as a stub.
//
// …unless the engine said WHY (D9). A crypto row's social/channels/seasonality
// factors are null by POLICY — the owner's directive, quoted and dated, sitting
// right there in each factor's own `detail` — and this screen dropped every word
// of it, so the reader was told the cohort had gaps in its wiring when what it
// had was a decision. A null carrying an explanation gets the explanation.

import type { EnginePrediction } from '../../lib/api'
import type { VerdictRead } from '../../lib/apiViews'

/** The engine's factor keys, in the reader's words. Unknown keys degrade to a
 * de-camel-cased version of the key itself rather than vanishing. Exported so
 * GatesLearning's weights section (plan Task 21) reads the same names this
 * page does — one label per factor key, never two. */
export const FACTOR_LABELS: Record<string, string> = {
  technical: 'technical',
  momentum: 'momentum',
  sector: 'sector',
  social: 'social',
  channels: 'channels',
  insiders: 'insiders',
  news: 'news tone',
  seasonality: 'seasonality',
  smartMoney: 'smart money',
  catalyst: 'catalyst',
}

export const labelOf = (key: string) => FACTOR_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

interface Vote {
  name: string
  value: number
  detail: string
}

/** A factor that could not score AND said why (D9). Two different absences hide
 * under one "no data" line: a factor whose input was missing this morning, and
 * a factor this cohort DELIBERATELY does not read — the crypto rows carry the
 * owner's directive, quoted and dated, in the very `detail` the screen threw
 * away. Listing "social, channels, seasonality" under "no data" told a crypto
 * reader the engine's wiring had gaps, when what it had was a policy. */
interface NotRead {
  names: string
  detail: string
}

/** One line per DISTINCT reason: social and channels are nulled by the same
 * sentence, and printing it twice is noise, not honesty. */
function groupNotRead(rows: { name: string; detail: string }[]): NotRead[] {
  const byDetail = new Map<string, string[]>()
  for (const r of rows) byDetail.set(r.detail, [...(byDetail.get(r.detail) ?? []), r.name])
  return [...byDetail].map(([detail, names]) => ({ detail, names: names.join(', ') }))
}

/** Board rows carry score AND weight (the vote is their product — what the
 * factor actually contributed to the composite); an on-demand read carries
 * the computed score alone. */
function toVotes(
  factors?: EnginePrediction['factors'],
  computed?: VerdictRead['computed'],
): { votes: Vote[]; missing: string[]; notRead: NotRead[] } {
  const nulls: { name: string; detail: string }[] = computed
    ? computed.filter(c => c.score == null).map(c => ({ name: labelOf(c.name), detail: (c.detail ?? '').trim() }))
    : Object.entries(factors ?? {})
        .filter(([, f]) => f.score == null)
        .map(([k, f]) => ({ name: labelOf(k), detail: (f.detail ?? '').trim() }))
  const votes = computed
    ? computed.filter(c => c.score != null).map(c => ({ name: labelOf(c.name), value: c.score as number, detail: c.detail }))
    : Object.entries(factors ?? {})
        .filter(([, f]) => f.score != null)
        .map(([k, f]) => ({ name: labelOf(k), value: (f.score as number) * f.weight, detail: f.detail }))
  return {
    votes,
    // a factor with no explanation is still just an absence, and still says so
    missing: nulls.filter(n => !n.detail).map(n => n.name),
    notRead: groupNotRead(nulls.filter(n => n.detail)),
  }
}

export function FactorVotes({ factors, computed, nulls }: { factors?: EnginePrediction['factors']; computed?: VerdictRead['computed']; nulls?: string[] }) {
  const { votes, missing, notRead } = toVotes(factors, computed)
  // `nulls` (the verdict's own list) wins when the caller has one — it is the
  // server's account of what could not be scored, not our inference from it.
  // It arrives as ENGINE KEYS ('smartMoney'), so it goes through labelOf like
  // every other name on this page; printing the keys raw put camelCase engine
  // internals in front of the reader (Task 17 review, I3).
  //
  // …minus the ones that explained themselves (D9): a factor named on both
  // lines would be reported as an absence and as a policy in the same breath.
  const explained = new Set(notRead.flatMap(n => n.names.split(', ')))
  const noData = (nulls && nulls.length > 0 ? nulls.map(labelOf) : missing).filter(n => !explained.has(n))
  const max = Math.max(1, ...votes.map(v => Math.abs(v.value)))

  return (
    <section aria-label="Factor votes">
      <p className="sec-label">Factor votes</p>
      {votes.length === 0 ? (
        <p className="cc-reason">No factor scored this name.</p>
      ) : (
        <div className="card sp-fv">
          {votes.map(v => {
            const width = `${(Math.abs(v.value) / max) * 50}%`
            return (
              <div className="sp-fv-row" key={v.name} title={v.detail}>
                <span className="sp-fv-name">{v.name}</span>
                <span className="sp-fv-track">
                  <i className={v.value >= 0 ? 'pos' : 'neg'} style={v.value >= 0 ? { left: '50%', width } : { right: '50%', width }} />
                </span>
                <span className="sp-fv-val num">{v.value >= 0 ? '+' : '−'}{Math.abs(v.value).toFixed(1)}</span>
              </div>
            )
          })}
        </div>
      )}
      {notRead.length > 0 && (
        <ul className="cc-reason sp-fv-notread" aria-label="Factors not read">
          {notRead.map(n => (
            <li key={n.names}>
              <span className="sp-fv-name">{n.names}</span> — {n.detail}
            </li>
          ))}
        </ul>
      )}
      {noData.length > 0 && <p className="cc-reason sp-fv-null">no data: {noData.join(', ')}</p>}
    </section>
  )
}
