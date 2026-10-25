import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { StrategyChoices } from './StrategyChoices'
import { STRATEGY_DEFINITIONS, STRATEGY_SCREEN_VERSION, type StrategyScreenKey } from '../../../shared/engine/strategyScreens'
import type { StrategyChoicesSnapshot, StrategyChoiceMatch, StrategyChoiceCandidate } from '../../../shared/engine/strategyChoices'
import { HISTORY_VERSION, HISTORY_CORE_MODEL, type HistoricalStudy, type HistoricalStats } from '../../../shared/engine/historyEvidence'

const now=()=>Math.floor(Date.now()/1000)
const match=(symbol:string,sector='XLK',extra:Partial<StrategyChoiceMatch>={}):StrategyChoiceMatch=>({symbol,sector,lastPrice:123,asOf:now()-86400,side:'long',status:'matches',reasons:[`${symbol} meets this strategy's price and business checks.`,'Revenue rose in the reported quarter.'],risks:['Results are due soon.'],...extra})
function snapshot(rows:Partial<Record<StrategyScreenKey,StrategyChoiceMatch[]>>={}):StrategyChoicesSnapshot {
  return {version:'current-strategy-choices-v1',rulesVersion:STRATEGY_SCREEN_VERSION,generatedAt:now()-60,scope:'55 US research stocks and followed US shares',symbols:['AAPL','MSFT','XOM'],unavailableSymbols:[],strategies:STRATEGY_DEFINITIONS.map(d=>({...d,status:rows[d.key]?.length?'ready':'no-matches',matches:rows[d.key]??[],counts:{evaluated:3,missing:0,noMatch:3-(rows[d.key]?.length??0),matched:rows[d.key]?.filter(r=>r.status==='matches').length??0,blocked:rows[d.key]?.filter(r=>r.status==='blocked').length??0},gaps:[]}))}
}
const stats=(excess:number):HistoricalStats=>({n:20,quarters:8,meanReturnPct:5,meanMarketPct:5-excess,excessPp:excess,beatRate:.5,brier:null,baselineBrier:null,uncertaintyPp:[-3,4]})
const history=():HistoricalStudy=>({version:HISTORY_VERSION,coreModel:HISTORY_CORE_MODEL,generatedAt:now()-60,dataThrough:now()-86400,dataFrom:1451606400,evaluationFrom:1577836800,symbols:['AAPL'],missingSymbols:[],strategies:[{key:'quarterly-recovery',label:'Quarterly',description:'Quarterly rule',horizon:63,financial:true,status:'behind',stats:stats(-2),sectorStats:stats(-1),sectorStatus:'behind',years:[],cancelledN:0,missingN:0},{key:'sector-leader',label:'Sector leader',description:'Sector rule',horizon:20,status:'uncertain',stats:stats(1),sectorStats:stats(.5),sectorStatus:'uncertain',years:[],cancelledN:0,missingN:0}],gates:[],liveGate:{year:2026,trainingFrom:1,trainingThrough:2,n:0,months:0,excessPp:null,brierSkill:null,allow:false},financialCoverage:{version:'sec-asof-quarterly-v2',symbols:['AAPL'],unavailableSymbols:[],snapshots:4},costBpsPerSide:10,dataDigest:'test',caveats:[],unavailable:[]})
const mount=(props:Parameters<typeof StrategyChoices>[0])=>render(<Router base="/app"><StrategyChoices {...props}/></Router>)
afterEach(()=>window.history.replaceState({},'','/'))

describe('independent current strategy choices',()=>{
  it('shows only the selected strategy and switches its own history as well as its stocks',()=>{
    mount({snapshot:snapshot({'quarterly-recovery':[match('AAPL')],'sector-leader':[match('MSFT')]}),historicalStudy:history()})
    expect(screen.getByRole('combobox',{name:'Strategy'})).toHaveValue('quarterly-recovery')
    expect(screen.getByRole('article',{name:'AAPL strategy match'})).toBeVisible()
    expect(screen.queryByRole('article',{name:'MSFT strategy match'})).not.toBeInTheDocument()
    expect(screen.getByLabelText('Selected strategy history')).toHaveTextContent('-2.00 pts')
    fireEvent.change(screen.getByRole('combobox',{name:'Strategy'}),{target:{value:'sector-leader'}})
    expect(screen.queryByRole('article',{name:'AAPL strategy match'})).not.toBeInTheDocument()
    expect(screen.getByRole('article',{name:'MSFT strategy match'})).toBeVisible()
    expect(screen.getByLabelText('Selected strategy history')).toHaveTextContent('+1.00 pts')
    expect(screen.getByLabelText('Selected strategy history')).not.toHaveTextContent('-2.00 pts')
    expect(new URLSearchParams(window.location.search).get('strategy')).toBe('sector-leader')
    expect(screen.queryByText('All strategies')).not.toBeInTheDocument()
  })
  it('restores a shared strategy URL and leaves other strategy candidates out of search',()=>{
    window.history.replaceState({},'','/app/stocks?view=strategies&strategy=sector-leader')
    mount({snapshot:snapshot({'quarterly-recovery':[match('AAPL')],'sector-leader':[match('MSFT'),match('XOM','XLE')]})})
    expect(screen.getByRole('combobox',{name:'Strategy'})).toHaveValue('sector-leader')
    fireEvent.change(screen.getByRole('combobox',{name:'Sector'}),{target:{value:'XLE'}})
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('article')).toHaveAccessibleName('XOM strategy match')
    fireEvent.change(screen.getByRole('searchbox',{name:'Find a stock'}),{target:{value:'AAPL'}})
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByText(/No current choices match these stock and sector filters/)).toBeVisible()
    fireEvent.click(screen.getByRole('button',{name:'Clear filters'}))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(new URLSearchParams(window.location.search).get('view')).toBe('strategies')
  })
  it.each(['pushState','replaceState'] as const)('follows an in-app %s change to the selected strategy without remounting',method=>{
    window.history.replaceState({},'','/app/stocks?view=strategies')
    mount({snapshot:snapshot({'quarterly-recovery':[match('AAPL')],'sector-leader':[match('MSFT')]})})
    fireEvent.change(screen.getByRole('searchbox',{name:'Find a stock'}),{target:{value:'AAPL'}})
    act(()=>window.history[method]({},'','/app/stocks?view=strategies&strategy=sector-leader'))
    expect(screen.getByRole('combobox',{name:'Strategy'})).toHaveValue('sector-leader')
    expect(screen.getByRole('searchbox',{name:'Find a stock'})).toHaveValue('')
    expect(screen.queryByRole('article',{name:'AAPL strategy match'})).not.toBeInTheDocument()
    expect(screen.getByRole('article',{name:'MSFT strategy match'})).toBeVisible()
  })
  it('does not describe a valuation screen as a price prediction',()=>{
    mount({snapshot:snapshot({'quality-value':[match('AAPL')]})})
    fireEvent.change(screen.getByRole('combobox',{name:'Strategy'}),{target:{value:'quality-value'}})
    const card=screen.getByRole('article')
    expect(card).toHaveTextContent('Matches the rules')
    expect(card).not.toHaveTextContent(/Pattern points|Watching for a rise/)
  })
  it('does not populate an empty strategy with choices from another strategy',()=>{
    mount({snapshot:snapshot({'sector-leader':[match('MSFT')]})})
    expect(screen.getByText('No stocks match these rules today')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Leaders in strong sectors 1'}))
    expect(screen.getByRole('article',{name:'MSFT strategy match'})).toBeVisible()
  })
  it('distinguishes missing input data from no matches and keeps blocked patterns on watch',()=>{
    const data=snapshot({'direction-core':[match('MSFT','XLK',{status:'blocked',risks:['The historical evidence gate failed.']})]})
    const quarterly=data.strategies.find(s=>s.key==='quarterly-recovery')!
    quarterly.status='missing-data';quarterly.counts.missing=3;quarterly.gaps=['Recent financial reports are missing.']
    mount({snapshot:data})
    expect(screen.getByText('Not enough data to make this list')).toBeVisible()
    fireEvent.change(screen.getByRole('combobox',{name:'Strategy'}),{target:{value:'direction-core'}})
    const card=screen.getByRole('article')
    expect(within(card).getByText('Watch only')).toBeVisible()
    expect(within(card).queryByText('Matches the rules')).not.toBeInTheDocument()
    expect(within(card).getByText(/historical evidence gate failed/)).not.toBeVisible()
    fireEvent.click(within(card).getByText('See the evidence'))
    expect(within(card).getByText(/historical evidence gate failed/)).toBeVisible()
    expect(card).not.toHaveTextContent('success probability')
  })
  it.each(['old','future','rules'] as const)('does not call a %s scan current',kind=>{
    const data=snapshot({'quarterly-recovery':[match('AAPL')]})
    if(kind==='old')data.generatedAt=now()-49*3600
    if(kind==='future')data.generatedAt=now()+3600
    if(kind==='rules')data.rulesVersion='other' as typeof STRATEGY_SCREEN_VERSION
    mount({snapshot:data})
    expect(screen.getByText('A fresh scan is needed')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })
  it('offers an explicit refresh for unavailable data without inventing a stock list',()=>{
    const refresh=vi.fn()
    mount({snapshot:null,onRefresh:refresh,error:'unavailable'})
    expect(screen.getByText('Waiting for the first strategy scan')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('could not be retrieved')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Check for updates'}))
    expect(refresh).toHaveBeenCalledOnce()
  })
  it.each(['version','model','horizon','financial','future'] as const)('rejects incompatible historical %s without borrowing another strategy’s history',kind=>{
    const study=history()
    if(kind==='version')study.version='old'
    if(kind==='model')study.coreModel='other'
    if(kind==='horizon')study.strategies[0].horizon=20
    if(kind==='financial')study.financialCoverage=undefined
    if(kind==='future')study.dataThrough=now()+86400
    mount({snapshot:snapshot({'quarterly-recovery':[match('AAPL')]}),historicalStudy:study})
    expect(screen.getByLabelText('Selected strategy history')).toHaveTextContent('No comparable historical result')
    expect(screen.getByLabelText('Selected strategy history')).not.toHaveTextContent('-2.00 pts')
  })
  it('explains price-qualified exclusions without treating missing data or strict rules as an unhealthy business',()=>{
    const data=snapshot()
    const group=data.strategies.find(s=>s.key==='quarterly-recovery')!
    group.diagnostics={priceMatched:4,priceFailed:3,missingPrices:2,failedFinancial:2,missingFinancial:2,specialist:1,candidatesTotal:4,candidatesTruncated:false,candidates:[
      {symbol:'MCD',sector:'XLY',category:'financial-rule',healthStatus:'unknown',reasons:['Debt is above this strategy’s limit.'],missing:[],failed:['Debt is above this strategy’s limit.']},
      {symbol:'NKE',sector:'XLY',category:'missing-data',healthStatus:'unknown',reasons:['Cash flow is not available.'],missing:['Cash flow is not available.'],failed:[]},
      {symbol:'PEP',sector:'XLP',category:'mixed',healthStatus:'unknown',reasons:[],missing:['Quarterly sales comparison is missing.'],failed:['Latest profit margin is below the rule.']},
      {symbol:'JPM',sector:'XLF',category:'specialist',healthStatus:'unknown',reasons:['Bank capital needs a specialist assessment.'],missing:[],failed:[]},
    ]}
    data.symbols=['MCD','NKE','PEP','JPM','AAPL','MSFT','XOM','TSLA','BA']
    group.counts={evaluated:4,missing:5,noMatch:4,matched:0,blocked:0}
    mount({snapshot:data})
    const funnel=screen.getByLabelText('Why stocks passed or were excluded')
    expect(within(funnel).getByText('Stocks in scan').parentElement).toHaveTextContent('9')
    expect(within(funnel).getByText('Price rules met').parentElement).toHaveTextContent('4')
    expect(within(funnel).getByText('Company checks passed').parentElement).toHaveTextContent('0')
    expect(funnel).toHaveTextContent('3 did not meet this strategy’s price rules')
    expect(funnel).toHaveTextContent('2 could not be checked because usable price history was missing')
    expect(screen.getByText(/these counts can overlap/)).toBeVisible()
    expect(screen.getByText(/does not mean the business is unhealthy/)).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByText('Debt is above this strategy’s limit.')).not.toBeVisible()
    fireEvent.click(screen.getByText('See the evidence: why stocks were excluded'))
    expect(screen.getByRole('link',{name:'MCD'})).toHaveAttribute('href','/app/stock/MCD')
    expect(screen.getAllByText('Debt is above this strategy’s limit.')).toHaveLength(1)
    expect(screen.getByText('Cash flow is not available.')).toBeVisible()
    expect(screen.getByText('Bank capital needs a specialist assessment.')).toBeVisible()
    expect(screen.getByText('Missing data and unmet rules')).toBeVisible()
    fireEvent.change(screen.getByRole('combobox',{name:'Strategy'}),{target:{value:'sector-leader'}})
    expect(screen.queryByRole('link',{name:'MCD'})).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Why stocks passed or were excluded')).not.toBeInTheDocument()
  })
  it('keeps the expanded scan count distinct from the smaller historical sample',()=>{
    const data=snapshot();data.symbols=Array.from({length:180},(_,i)=>`STOCK${i}`);data.scope='Expanded US research sample and followed shares.'
    const study=history();study.symbols=data.symbols.slice(0,55);study.financialCoverage!.symbols=data.symbols.slice(0,42)
    mount({snapshot:data,historicalStudy:study})
    expect(screen.getByText('180 stocks included in this scan')).toBeVisible()
    expect(screen.getByText(/Historical sample: 55 stocks/)).toHaveTextContent('Company filings cover 42 stocks. This is separate from the current scan.')
    expect(screen.queryByLabelText('Why stocks passed or were excluded')).not.toBeInTheDocument()
  })
  it('shows price failures without suggesting company health was assessed',()=>{
    const data=snapshot(),group=data.strategies.find(s=>s.key==='quarterly-recovery')!
    group.diagnostics={priceMatched:0,priceFailed:2,missingPrices:1,failedFinancial:0,missingFinancial:0,specialist:0,candidatesTotal:0,candidatesTruncated:false,candidates:[]}
    mount({snapshot:data})
    expect(screen.getByLabelText('Why stocks passed or were excluded')).toHaveTextContent('No stocks reached the company checks in this scan.')
    expect(screen.queryByLabelText('Reasons for exclusion')).not.toBeInTheDocument()
    expect(screen.queryByText('See the evidence: why stocks were excluded')).not.toBeInTheDocument()
  })
  it('distinguishes a capped example list from all exclusions and keeps valuation free of a price-pattern claim',()=>{
    const data=snapshot(),group=data.strategies.find(s=>s.key==='quality-value')!
    const candidates:StrategyChoiceCandidate[]=Array.from({length:9},(_,i)=>({symbol:`CO${i}`,sector:'XLK',category:'missing-data',healthStatus:'unknown',reasons:[],missing:['Company filings are incomplete.'],failed:[]}))
    data.symbols=Array.from({length:90},(_,i)=>`CO${i}`)
    group.counts={evaluated:0,missing:90,noMatch:0,matched:0,blocked:0}
    group.diagnostics={priceMatched:90,priceFailed:0,missingPrices:0,failedFinancial:0,missingFinancial:90,specialist:0,candidatesTotal:90,candidatesTruncated:true,candidates}
    mount({snapshot:data})
    fireEvent.change(screen.getByRole('combobox',{name:'Strategy'}),{target:{value:'quality-value'}})
    expect(screen.getByText('Price data usable')).toBeVisible()
    expect(screen.queryByText('Price rules met')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('See the evidence: why stocks were excluded'))
    expect(screen.getByText(/Showing 8 of 90 excluded stocks/)).toHaveTextContent('This scan includes 9 stock examples; the totals above cover all 90.')
    expect(screen.queryByRole('link',{name:'CO8'})).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Show more excluded stocks'}))
    expect(screen.getByRole('link',{name:'CO8'})).toBeVisible()
    expect(screen.getByText(/Showing 9 of 90 excluded stocks/)).toBeVisible()
    expect(screen.queryByRole('button',{name:'Show more excluded stocks'})).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

})
