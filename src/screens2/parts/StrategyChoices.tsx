import { useEffect, useId, useState } from 'react'
import { Link, useSearch } from 'wouter'
import type { StrategyChoicesSnapshot, StrategyChoiceMatch, StrategyScreenKey } from '../../../shared/engine/strategyChoices'
import { STRATEGY_DEFINITIONS, STRATEGY_SCREEN_VERSION } from '../../../shared/engine/strategyScreens'
import { HISTORY_VERSION, HISTORY_CORE_MODEL, type HistoricalStudy, type HistoricalStrategy } from '../../../shared/engine/historyEvidence'
import { sectorFinancialPolicy } from '../../../shared/sectorFinancials'
import { holdingPeriod, strategyName } from '../../lib/plainLanguage'
import '../../styles/strategy-choices.css'

const DEFAULT_STRATEGY: StrategyScreenKey = 'quarterly-recovery'
const names: Partial<Record<StrategyScreenKey, string>> = {
  'quarterly-recovery': 'Recovery with steady company results',
  'sector-leader': 'Leaders in strong sectors',
  'shock-rebound': 'Rebound after a sharp sell-off',
}
const name = (key: StrategyScreenKey, fallback: string) => names[key] ?? strategyName(key, fallback)
const summary: Record<StrategyScreenKey, string> = {
  'direction-core': 'A short-term price pattern to watch. Earlier results do not support using it as a trading signal.',
  'direction-gated': 'The short-term pattern, allowed only when its own earlier evidence passes the extra checks.',
  'pullback-price': 'Shares that fell from a recent high and have started to recover. This screen checks prices only.',
  'trend-price': 'Shares in an established rising trend that recently outperformed the US market.',
  'big-drop-price': 'Shares 20–60% below their yearly high, with early signs of a price recovery. Business health is not checked here.',
  'healthy-drop': 'A large price fall and signs of recovery, supported by company profits, cash flow and financial checks.',
  'healthy-value-drop': 'A healthy-business recovery that also passes the strategy’s price and valuation checks.',
  'quality-trend': 'An established rising price trend, supported by the strategy’s financial checks.',
  'quality-value': 'Businesses that pass the financial and valuation checks. A price fall is not required.',
  'quarterly-recovery': 'A large price fall and early recovery, with steady or improving quarterly results and positive yearly profit and cash flow.',
  'sector-leader': 'Shares outperforming their own sector, while that sector is outperforming the US market.',
  'shock-rebound': 'A strong, high-volume rebound after a sharp fall. The price pattern does not establish what caused the fall.',
}
const cardReason: Record<StrategyScreenKey,string> = {
  'direction-core': 'A short-term price pattern was found. This unfiltered version stays on watch.',
  'direction-gated': 'A short-term price pattern was found and checked against its own historical evidence.',
  'pullback-price': 'The price has started recovering after a pullback.',
  'trend-price': 'The longer price trend is rising, and the stock has recently beaten the market.',
  'big-drop-price': 'The price has started recovering after losing at least a fifth of its value.',
  'healthy-drop': 'The price is recovering after a large fall, and the company passes its financial health checks.',
  'healthy-value-drop': 'Recovery signs and healthy company finances, with a valuation inside this strategy’s limits.',
  'quality-trend': 'The price is trending upwards, supported by healthy company finances.',
  'quality-value': 'The company passes the financial checks, and its valuation is within this strategy’s limits.',
  'quarterly-recovery': 'Recovery signs after a large price fall, with steady or improving company results.',
  'sector-leader': 'This stock is beating its sector, while the sector is beating the wider market.',
  'shock-rebound': 'The price bounced strongly after a sharp fall, with more trading than usual.',
}
const sectorName = (code: string | null) => code ? sectorFinancialPolicy(code)?.label ?? code : 'Sector unavailable'
const stamp = (at: number) => Number.isFinite(at) && at > 0 ? new Date(at * 1000).toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'UTC'}) + ' UTC' : 'Date unavailable'
const day = (at: number) => Number.isFinite(at) && at > 0 ? new Date(at*1000).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}) : 'Date unavailable'
const signed = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(2)} pts`
const historicalLabel = (status: HistoricalStrategy['status'] | undefined, target: string) => status === 'ahead' ? `Ahead of ${target} in this test`
  : status === 'behind' ? `Below ${target} in this test` : status === 'uncertain' ? `No reliable advantage over ${target} yet` : `No completed comparison with ${target}`
function selectionFromSearch(search:string): StrategyScreenKey {
  const key = new URLSearchParams(search).get('strategy')
  return STRATEGY_DEFINITIONS.some(d=>d.key===key) ? key as StrategyScreenKey : DEFAULT_STRATEGY
}

function MatchCard({ row, strategyKey }: {row: StrategyChoiceMatch; strategyKey:StrategyScreenKey}) {
  const direction = strategyKey==='direction-core' || strategyKey==='direction-gated'
  return <article className={`strategy-choice-card${row.status==='blocked'?' strategy-choice-blocked':''}`} aria-label={`${row.symbol} strategy match`}>
    <div className="strategy-choice-card-head"><div><Link href={`/stock/${encodeURIComponent(row.symbol)}`}>{row.symbol}</Link>{row.name && <span>{row.name}</span>}</div><span className="strategy-choice-state">{row.status==='blocked'?'Watch only':'Matches the rules'}</span></div>
    <p className="strategy-choice-sector">{sectorName(row.sector)}{direction && <> · {row.side==='short'?'Watching for a fall':'Watching for a rise'}</>}</p>
    <p className="strategy-choice-reason">{cardReason[strategyKey]}</p>
    <div className="strategy-choice-close"><span>Last checked close</span><strong>{new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(row.lastPrice)}</strong><small>{day(row.asOf)}</small></div>
    <details><summary>See the evidence</summary>
      {row.reasons.length>0 && <ul>{row.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>}
      {row.risks.length>0 && <><p><b>What to check</b></p><ul>{row.risks.map((risk,i)=><li key={i}>{risk}</li>)}</ul></>}
      <p>{row.status==='blocked'?'This stock remains on watch because a safety check did not pass. Review the checks above.':'This is a rule match, not a trade plan or a probability of success.'}</p>
      <Link href={`/stock/${encodeURIComponent(row.symbol)}`}>Open {row.symbol} research</Link>
    </details>
  </article>
}

function StrategyHistory({ study, strategyKey }: {study?:HistoricalStudy|null;strategyKey:StrategyScreenKey}) {
  const now=Date.now()/1000
  const definition=STRATEGY_DEFINITIONS.find(d=>d.key===strategyKey)!
  const comparable=study && study.version===HISTORY_VERSION && study.coreModel===HISTORY_CORE_MODEL &&
    study.generatedAt>0 && study.generatedAt<=now && study.dataThrough>0 && study.dataThrough<=study.generatedAt &&
    study.dataFrom<=study.evaluationFrom && study.evaluationFrom<=study.dataThrough &&
    (!definition.financial || study.financialCoverage?.version==='sec-asof-quarterly-v2')
  const row=comparable ? study.strategies.find(s=>s.key===strategyKey && s.horizon===definition.horizon && !!s.financial===!!definition.financial) : null
  if (!row) return <section className="strategy-choice-history" aria-label="Selected strategy history"><h3>How this strategy tested</h3><p>No comparable historical result is available for this strategy yet. Another strategy’s results are not used in its place.</p></section>
  return <section className="strategy-choice-history" aria-label="Selected strategy history">
    <div className="strategy-choice-subhead"><h3>How this strategy tested</h3><span>All tested sectors · {holdingPeriod(row.horizon)}</span></div>
    <p>{historicalLabel(row.status,'the US market')}. {historicalLabel(row.sectorStatus,'sector funds')}.</p>
    <dl className="strategy-choice-stats"><div><dt>Above / below the market</dt><dd>{signed(row.stats.excessPp)}</dd></div><div><dt>Above / below the sector</dt><dd>{signed(row.sectorStats?.excessPp)}</dd></div><div><dt>Completed examples</dt><dd>{row.stats.n.toLocaleString()}</dd></div></dl>
    <p className="strategy-choice-muted">Average difference per completed idea, after estimated costs. This does not establish future success.</p>
    <details><summary>See the evidence: this strategy’s results</summary>
      <p>Evaluated from {day(study!.evaluationFrom)} through {day(study!.dataThrough)}. Updated {day(study!.generatedAt)}. Current-stock filters above do not change these historical totals.</p>
      {now-study!.generatedAt>45*86400 && <p>This historical study is over 45 days old and should be refreshed.</p>}
      {!!row.missingSectorN && <p>Sector comparison covers {row.sectorStats?.n ?? 0} of {row.stats.n} examples. Missing dates are excluded, not estimated.</p>}
      {row.stats.uncertaintyPp && <p>Market difference uncertainty: {signed(row.stats.uncertaintyPp[0])} to {signed(row.stats.uncertaintyPp[1])}. A range crossing zero means the advantage is uncertain.</p>}
      {!!row.sectors?.length && <div className="strategy-choice-table"><table><caption>Sector breakdown · averages, not proven sector advantages</caption><thead><tr><th>Sector</th><th>Examples</th><th>Vs market</th><th>Vs sector</th></tr></thead><tbody>{row.sectors.map(s=><tr key={s.sector}><th>{sectorName(s.sector)}</th><td>{s.stats.n}</td><td>{signed(s.stats.excessPp)}</td><td>{signed(s.sectorStats?.excessPp)}{s.sectorStats && s.sectorStats.n!==s.stats.n ? ` (${s.sectorStats.n} matched)` : ''}</td></tr>)}</tbody></table></div>}
      <p>{row.description}</p><p>The fixed stock sample has survivorship bias. These are historical simulations, not forecasts saved at the time. Current matches have no measured outcome yet.</p>
    </details>
  </section>
}

export function StrategyChoices({snapshot,historicalStudy,onRefresh,refreshing=false,error}: {
  snapshot?:StrategyChoicesSnapshot|null; historicalStudy?:HistoricalStudy|null
  onRefresh?:()=>void; refreshing?:boolean; error?:string|null
}) {
  const id=useId()
  const search=useSearch()
  const [selected,setSelected]=useState<StrategyScreenKey>(()=>selectionFromSearch(search))
  const [sector,setSector]=useState(''), [query,setQuery]=useState(''), [limit,setLimit]=useState(12)
  useEffect(()=>{setSelected(selectionFromSearch(search));setSector('');setQuery('');setLimit(12)},[search])
  const definition=STRATEGY_DEFINITIONS.find(d=>d.key===selected)!
  const group=snapshot?.strategies.find(s=>s.key===selected)
  const now=Date.now()/1000
  const current=!!snapshot && snapshot.version==='current-strategy-choices-v1' && snapshot.rulesVersion===STRATEGY_SCREEN_VERSION && snapshot.generatedAt>0 && snapshot.generatedAt<=now && now-snapshot.generatedAt<=48*3600
  const alternatives=current ? snapshot.strategies.filter(s=>s.key!==selected && s.counts.matched>0).slice(0,4) : []
  const matches=current ? group?.matches ?? [] : []
  const sectors=[...new Set(matches.map(r=>r.sector).filter((s):s is string=>!!s))].sort((a,b)=>sectorName(a).localeCompare(sectorName(b)))
  const filtered=matches.filter(row=>(!sector || row.sector===sector) && (!query.trim() || `${row.symbol} ${row.name??''}`.toLowerCase().includes(query.trim().toLowerCase())))
  function select(value:string) {
    const key=value as StrategyScreenKey
    if (!STRATEGY_DEFINITIONS.some(d=>d.key===key)) return
    setSelected(key);setSector('');setQuery('');setLimit(12)
    const url=new URL(window.location.href);url.searchParams.set('strategy',key)
    window.history.replaceState(window.history.state,'',url)
  }
  return <section className="strategy-choices" aria-label="Stocks by individual strategy">
    <header className="strategy-choice-heading"><div><p className="strategy-choice-eyebrow">One strategy at a time</p><h2>Stocks by strategy</h2></div>{onRefresh && <button type="button" className="strategy-choice-refresh" onClick={onRefresh} disabled={refreshing}>{refreshing?'Updating…':'Check for updates'}</button>}</header>
    <p className="strategy-choice-intro">Choose the approach you want to explore. Each strategy has its own stock list, rules and results.</p>
    <label className="strategy-choice-select" htmlFor={`${id}-strategy`}>Strategy<select id={`${id}-strategy`} value={selected} onChange={e=>select(e.target.value)}>{STRATEGY_DEFINITIONS.map(d=>{
      const g=snapshot?.strategies.find(s=>s.key===d.key)
      return <option key={d.key} value={d.key}>{name(d.key,d.label)}{current && g ? ` · ${g.counts.matched} matches${g.counts.blocked?` / ${g.counts.blocked} watch only`:''}`:''}</option>
    })}</select></label>
    <div className="strategy-choice-about"><div><h3>{name(selected,definition.label)}</h3><span>{holdingPeriod(definition.horizon)} · Research screen</span></div><p>{summary[selected]}</p><details><summary>See the evidence: exact rules</summary><p>{definition.description}</p><p>These rules are shared with this strategy’s historical test. No overall score combines it with other strategies. A stock can appear in more than one independent list.</p></details></div>
    {error && <p className="strategy-choice-alert" role="alert">The latest scan could not be retrieved. {snapshot?'The saved scan is shown with its original date.':'Please try checking for updates.'}</p>}
    {snapshot && <p className="strategy-choice-muted">Scan: {stamp(snapshot.generatedAt)} · {snapshot.scope}</p>}
    {!snapshot ? <div className="strategy-choice-empty" role="status"><h3>Waiting for the first strategy scan</h3><p>Current matches will appear here after the free cloud scan publishes. Historical results below are kept separate.</p></div>
      : !current ? <div className="strategy-choice-empty" role="status"><h3>A fresh scan is needed</h3><p>The saved scan is over two days old, has an invalid date or uses different rules. Its stock list is not presented as current choices.</p></div>
      : !group ? <div className="strategy-choice-empty" role="status"><h3>This strategy has not been scanned yet</h3><p>Its current list is unavailable. Other strategies are not used to fill the gap.</p></div>
      : <>
        <div className="strategy-choice-subhead"><h3>Current stock choices</h3><span>{group.counts.matched} match{group.counts.matched===1?'':'es'}{group.counts.blocked ? ` · ${group.counts.blocked} watch only` : ''}</span></div>
        <p className="strategy-choice-muted">{group.counts.evaluated} stocks checked for this strategy.{group.counts.missing ? ` ${group.counts.missing} could not be fully assessed; missing information never counts as a match.`:''} Matching the rules does not mean a stock will rise.</p>
        {matches.length>0 && <div className="strategy-choice-filters"><label htmlFor={`${id}-sector`}>Sector<select id={`${id}-sector`} value={sector} onChange={e=>{setSector(e.target.value);setLimit(12)}}><option value="">All sectors</option>{sectors.map(s=><option value={s} key={s}>{sectorName(s)}</option>)}</select></label><label htmlFor={`${id}-stock`}>Find a stock<input id={`${id}-stock`} type="search" value={query} placeholder="Name or ticker" onChange={e=>{setQuery(e.target.value);setLimit(12)}} /></label></div>}
        {!matches.length ? <div className="strategy-choice-empty" role="status"><h3>{group.status==='missing-data'?'Not enough data to make this list':'No stocks match these rules today'}</h3><p>{group.status==='missing-data'?'The scan could not assess enough of the required information. This is a data gap, not a negative view on the stocks.':`Of the stocks checked, none passed this strategy’s rules.${group.counts.missing?' Some stocks could not be fully assessed.':''} The criteria have not been loosened to fill the list.`}</p></div>
          : !filtered.length ? <div className="strategy-choice-empty" role="status"><p>No current choices match these stock and sector filters.</p><button type="button" onClick={()=>{setSector('');setQuery('')}}>Clear filters</button></div>
          : <><p className="strategy-choice-muted">Showing {Math.min(limit,filtered.length)} of {filtered.length} {sector?'in this sector':'in this strategy'}. Listed by symbol, not a combined recommendation rank.</p><div className="strategy-choice-cards">{[...filtered].sort((a,b)=>a.symbol.localeCompare(b.symbol)).slice(0,limit).map(row=><MatchCard key={row.symbol} row={row} strategyKey={selected}/>)}</div>{filtered.length>limit && <button className="strategy-choice-more" type="button" onClick={()=>setLimit(n=>n+12)}>Show more stocks</button>}</>}
        {!matches.length && alternatives.length>0 && <div className="strategy-choice-alternatives"><p>Other separate lists have matches. Choose one to inspect its own rules.</p><div>{alternatives.map(s=><button type="button" key={s.key} onClick={()=>select(s.key)}>{name(s.key,s.label)} <span>{s.counts.matched}</span></button>)}</div></div>}
        {!!group.gaps.length && <details className="strategy-choice-coverage"><summary>See the evidence: scan coverage</summary><ul>{group.gaps.map((gap,i)=><li key={i}>{gap}</li>)}</ul><p>{group.counts.noMatch} checked stocks did not meet the rules; {group.counts.blocked} patterns remain blocked by their own evidence checks.</p></details>}
      </>}
    <StrategyHistory study={historicalStudy} strategyKey={selected}/>
    <p className="strategy-choice-footer">Current rule matches are separate from the app’s saved forecasts and trade plans. <Link href="/today?view=research">See the separate forecast models</Link>.</p>
  </section>
}
