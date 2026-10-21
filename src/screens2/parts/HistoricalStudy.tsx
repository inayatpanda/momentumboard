import type { HistoricalStudy as Study } from '../../../shared/engine/historyEvidence'

const signed = (n: number | null, unit = '%') => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}${unit}`
const date = (t: number) => new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const labels = { ahead: 'Ahead in this historical test', behind: 'Behind SPY', uncertain: 'Ahead on average · uncertain', 'no-trades': 'No qualifying trades' }

export function HistoricalStudy({ study }: { study?: Study | null }) {
  if (!study) return null
  const ahead = study.strategies.filter(s => s.status === 'ahead')
  const stale = Date.now() / 1000 - study.generatedAt > 45 * 86400
  return <section className="history-study" aria-label="Longer historical test">
    <div className="research-section-head"><div><p className="research-eyebrow">Longer history</p><h3>Which strategies beat the market?</h3></div><span className="research-mode">Historical simulation</span></div>
    <p>Free daily prices from {date(study.dataFrom)} to {date(study.dataThrough)}. Results below cover {date(study.evaluationFrom)} onward, after the initial learning period.</p>
    <div className="history-verdict"><strong>{ahead.length ? `${ahead.length} ${ahead.length === 1 ? 'strategy is' : 'strategies are'} ahead with historical support.` : 'No strategy has established a reliable advantage in this test.'}</strong><p>{ahead.length ? `${ahead.map(s => s.label).join(', ')} cleared the historical uncertainty and consistency checks. This still needs validation on forecasts saved in advance.` : 'A positive average alone is not enough. The results must also survive uncertainty checks and hold across different years.'}</p></div>
    <p className="research-muted">{study.symbols.length - study.missingSymbols.length} US stocks · 4 comparisons · SPY including dividend adjustments · {study.costBpsPerSide}bp estimated cost per side</p>
    {stale && <p role="status">This study is over 45 days old. The engine will not use it to support new setups until refreshed.</p>}
    <p className="research-muted">These are price-based tests. Financial recovery and social strategies still need dated evidence and are listed separately below.</p>
    <div className="history-strategies">{study.strategies.map(s => <article key={s.key} className={`history-strategy history-${s.status}`}>
      <div className="history-card-heading"><h4>{s.label}</h4><span>{s.horizon} sessions</span></div>
      <p className="history-status">{labels[s.status]}</p>
      {s.stats.n > 0 ? <><dl className="history-results"><div><dt>Strategy return</dt><dd>{signed(s.stats.meanReturnPct)}</dd></div><div><dt>SPY, same dates</dt><dd>{signed(s.stats.meanMarketPct)}</dd></div><div><dt>Excess per setup</dt><dd>{signed(s.stats.excessPp, 'pp')}</dd></div></dl>
      <p className="research-muted">{s.stats.n.toLocaleString()} setups · {s.years.filter(y => (y.stats.excessPp ?? 0) > 0).length}/{s.years.length} active years ahead · {s.stats.quarters} calendar quarters</p>
      <p className="history-range">{s.stats.uncertaintyPp ? `Excess uncertainty range: ${signed(s.stats.uncertaintyPp[0], 'pp')} to ${signed(s.stats.uncertaintyPp[1], 'pp')}` : 'Not enough history to estimate a useful uncertainty range.'}</p></> : <p>The earlier evidence failed the filter in every tested year. No signals were allowed, so there is no trading return to score.</p>}
      <details><summary>Rules and yearly results</summary><p>{s.description}</p>{s.years.length > 0 && <div className="history-table-scroll"><table><caption>Mean return per setup, after costs</caption><thead><tr><th>Year</th><th>Setups</th><th>Strategy</th><th>SPY</th><th>Excess</th></tr></thead><tbody>{s.years.map(y => <tr key={y.year}><th>{y.year}{y.year === new Date(study.dataThrough * 1000).getUTCFullYear() ? ' to date' : ''}</th><td>{y.stats.n}</td><td>{signed(y.stats.meanReturnPct)}</td><td>{signed(y.stats.meanMarketPct)}</td><td>{signed(y.stats.excessPp, 'pp')}</td></tr>)}</tbody></table></div>}<p>{s.cancelledN} gap-cancelled entries · {s.missingN} windows with missing sessions.</p>{s.stats.brier != null && <p>Probability error: {s.stats.brier.toFixed(3)} versus {s.stats.baselineBrier?.toFixed(3)} for the stock’s normal drift. Lower is better.</p>}</details>
    </article>)}</div>
    <div className="history-engine-change"><h4>How the engine learns from this</h4><p>Each year, the direction model checks the previous two years before allowing a setup. It needs at least 80 completed trades over 12 months, positive excess return and better probability estimates than normal drift. Failing signals remain on watch. No historical result can automatically promote a strategy to live trading.</p><p><b>{study.liveGate.year} filter: {study.liveGate.allow ? 'passed for the tested panel' : 'not supported — direction signals stay on watch'}.</b> Training ended {date(study.liveGate.trainingThrough)}; {study.liveGate.n} completed trades. Stocks outside the tested panel remain on watch.</p></div>
    <details className="research-method"><summary>Strategies that still need dated evidence</summary>{study.unavailable.map(s => <p key={s.label}><b>{s.label}:</b> {s.reason}</p>)}</details>
    <details className="research-method"><summary>Method, coverage and limits</summary>{study.caveats.map(c => <p key={c}>{c}</p>)}<p>Panel: {study.symbols.join(', ')}.</p><p>Updated {date(study.generatedAt)}. Scheduled weekly on public GitHub runners; no laptop or paid data service. Dataset fingerprint: {study.dataDigest.slice(0, 16)}.</p><p>The recorded-forecast audit below is separate and uses price returns without dividends; its numbers are not directly comparable with this simulation.</p></details>
  </section>
}
