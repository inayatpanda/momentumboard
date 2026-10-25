import type { ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'

export type SitePage = 'home' | 'engine' | 'paper' | 'ledger' | 'faq' | 'privacy'
const NAV: { page:SitePage;path:string;label:string }[] = [
  {page:'home',path:'/',label:'Overview'},
  {page:'engine',path:'/engine',label:'How it works'},
  {page:'paper',path:'/paper',label:'Daily research'},
  {page:'ledger',path:'/ledger',label:'Results'},
  {page:'faq',path:'/faq',label:'Questions'},
]
export function siteRouteFor(pathname:string):SitePage {
  const page=pathname.replace(/\/$/,'')
  return page==='/engine'?'engine':page==='/paper'?'paper':page==='/ledger'?'ledger':page==='/faq'?'faq':page==='/privacy'?'privacy':'home'
}
export function SiteNav({active}:{active:SitePage}) {
  return <nav className="site-nav" aria-label="Website">{NAV.map(item=><a key={item.page} href={item.path} aria-current={active===item.page?'page':undefined}>{item.label}</a>)}</nav>
}
export function SiteHeader({active}:{active:SitePage}) {
  return <header className="site-header"><div className="site-header-top"><a className="site-brand" href="/" aria-label="StreetSignal home"><BrandMark size={34}/><span>StreetSignal</span></a><a href="/app/" className="site-open">Open app</a></div><SiteNav active={active}/></header>
}
export function SiteFooter() {
  return <footer className="site-footer"><span>StreetSignal · Independent stock research</span><nav aria-label="Footer"><a href="/privacy">Privacy</a><a href="/faq">Questions</a><a href="/app/">Open app</a></nav></footer>
}
function SiteShell({active,title,kicker,children}:{active:SitePage;title:string;kicker:string;children:ReactNode}) {
  return <main className="landing"><div className="landing-col"><SiteHeader active={active}/><header className="site-page-hero"><p className="site-kicker">{kicker}</p><h1>{title}</h1></header><div className="site-prose">{children}</div><section className="site-page-cta"><div><h2>Research starts here.</h2><p>Free shared research. No signup or access key to enter.</p></div><a className="site-primary" href="/app/">Open the free app</a></section><SiteFooter/></div></main>
}
export function EnginePage() {
  return <SiteShell active="engine" kicker="How it works" title="A clearer view of the evidence.">
    <h2>Choose one strategy at a time</h2><p>StreetSignal scans a shared universe of 250 US stocks. Explore recovery after a large fall, healthy businesses at a reasonable valuation, rising price trends and strength within a sector. Each approach keeps its own rules, stock choices and historical results.</p>
    <p>The app explains why a stock passed. When a list is empty, it separates price rules that were not met, missing company information, financial rules that were not met and businesses that need specialist review.</p>
    <h2>Buy ideas and Review selling answer different questions</h2><p><b>Buy ideas</b> helps you find stocks worth researching. <b>Review selling</b> flags reasons to revisit a holding: repeated weakness in company results, a sustained broken price trend, or unusually stretched valuation.</p><p>A price warning does not prove that a business is getting worse. A review flag is not an instruction to sell, and the app does not know your full holdings, tax position or goals. It does not place trades.</p>
    <h2>Company results, prices and context</h2><p>Financial checks use reported profit, cash flow, growth, debt and valuation. Quarterly trends help show whether a business is improving or weakening. Price and sector comparisons help describe what the market is doing.</p><p>News, historical market patterns and selected YouTube channels add context. Source commentary remains a claim to examine, with links and coverage information, rather than proof of what happens next.</p>
    <h2>Evidence before confidence</h2><p>Current rule matches, historical simulations and forecasts saved before their outcomes are different kinds of evidence. The app labels them separately. Missing information stays missing; it does not become a positive signal.</p><p>Past tests can be useful without proving a dependable advantage. Read the dates, sample size, comparison with the market and sector, and the limits under “See the evidence”.</p>
  </SiteShell>
}
export function PaperPage() {
  return <SiteShell active="paper" kicker="Daily research" title="Understand what changed, and why it matters.">
    <h2>Start with your stocks</h2><p>Keep a watchlist, browse by sector and open a stock for its company results, price history and market context. Review what changed since the previous scan before deciding whether to investigate further.</p>
    <h2>See the wider picture</h2><p>The daily brief brings together current news, sector trends and historical relationships between shares, bonds, oil and precious metals. Similar past conditions provide context; they do not guarantee a repeat.</p>
    <h2>Selected channels, traceable findings</h2><p>YouTube research focuses on selected channels. Findings link back to their source and relevant stocks. The app shows processing coverage so you can tell when material is missing or only partly analysed.</p><p>Free access and processing quotas can delay new videos. A creator’s opinion is kept separate from the engine’s financial and price checks.</p>
    <h2>Your computer can be off</h2><p>Scheduled shared research runs in the cloud. Open the web app on your phone or computer when you want to read it. Freshness labels show when data was last checked.</p>
  </SiteShell>
}
export function LedgerPage() {
  return <SiteShell active="ledger" kicker="Results" title="Show the test, not just the claim.">
    <h2>Compare each strategy fairly</h2><p>Historical results show how each tested approach performed against the US market and sector funds, after estimated trading costs. An average that looks better is not automatically a reliable advantage.</p>
    <h2>Keep different evidence separate</h2><p>Historical simulations replay rules on past data. Saved forecasts can be checked after their stated time has passed. Current stock choices have not yet produced an outcome. None should borrow another strategy’s track record.</p>
    <h2>Check the sample and the dates</h2><p>The live research universe and historical test sample can differ. Results show the period covered, completed examples and missing information. A fixed historical stock sample can favour companies that survived, and free data can be revised.</p>
    <h2>Make uncertainty useful</h2><p>The app shows when an advantage is uncertain, when there is too little evidence and when a rule did not beat its comparison. Review selling flags are prompts for research; they are not validated forecasts of a future decline.</p><p>Open “See the evidence” for the assumptions behind a result. No strategy is presented as a guaranteed way to beat the market.</p>
  </SiteShell>
}
const FAQS = [
  {q:'Is StreetSignal free?',a:'The shared web research is free. There is no signup, payment form or access key to enter. Optional personal AI tools may need your own provider key and use that provider’s allowance; they are separate from the shared research.'},
  {q:'Does my Mac need to stay on?',a:'No. Scheduled shared research runs in the cloud. You only need a browser to read it. Free data and processing limits can cause delays or coverage gaps, which the app labels.'},
  {q:'What is the difference between Buy ideas and Review selling?',a:'Buy ideas looks for stocks that meet a strategy’s rules. Review selling highlights reasons to reassess a holding, including weaker company results, a sustained broken price trend or stretched valuation. Neither places trades or makes a personal recommendation.'},
  {q:'Why can a strategy show no stocks?',a:'Its rules may not match today, or the information needed to assess a stock may be missing. The app separates those reasons and identifies businesses that need specialist checks. It does not loosen the rules just to fill a list.'},
  {q:'Are all YouTube videos covered?',a:'No. Research focuses on selected channels and depends on access to the video and available free processing capacity. Check the coverage label and source link before relying on a finding.'},
  {q:'Can I use it like a phone app?',a:'Yes. Open the web app in your browser. On iPhone, use Safari’s Share menu and Add to Home Screen. On supported Android browsers, use Install app or Add to Home Screen. A desktop download is not required.'},
  {q:'Does past outperformance prove a strategy will work?',a:'No. Historical tests have limits, and a positive average can be uncertain. Each strategy shows its own comparison with the market and sector, with dates, sample sizes and assumptions.'},
  {q:'Is this financial advice?',a:'StreetSignal provides research and context, not personalised financial advice. It does not know your full financial circumstances. You decide whether to act, and it does not place trades.'},
]
export function FaqPage() {
  return <SiteShell active="faq" kicker="Questions" title="Straight answers.">{FAQS.map(item=><details key={item.q} className="site-faq"><summary>{item.q}</summary><p>{item.a}</p></details>)}<p>Read <a href="/privacy">how your data is stored and used</a> before adding personal notes or journal entries.</p></SiteShell>
}
export function PrivacyPage() {
  return <SiteShell active="privacy" kicker="Privacy" title="Your data, in plain language.">
    <h2>Access belongs to this browser</h2><p>Opening the app creates a random access ID for this browser profile. You do not need to provide a name, email address or payment details. The ID is stored on your device and sent with app requests so the server can keep your saved data separate from other visitors.</p><p>A different browser or device starts with different access. Do not assume your watchlist will automatically follow you to another device.</p>
    <h2>What stays in your browser, and what syncs</h2><p>The app keeps watchlists, preferences, alert rules, notes, journal entries and cached research in browser storage. Watchlists, alert rules, selected channels, capital settings and notes can also be copied to the server. Journal use can upload positions, trade history and a backup of related settings.</p><p>Synced data is stored under your access ID. The server operator can access it; it is not encrypted in a way that hides it from the operator. Avoid putting passwords or financial account details in notes.</p>
    <h2>Shared research and optional services</h2><p>Market research and selected-channel findings are shared app content. Personal watchlists and journal entries are separate from those shared findings. Optional email or notification features need the delivery details you choose to provide.</p><p>Some personal AI features need a provider key. New keys are stored in this browser and excluded from backups. When you use an AI feature, the key and relevant prompt or content pass through the app’s server to the provider. Shared research does not require your own key.</p><p>Older installations may still have a previously saved AI key on the server. Settings can show that and remove the server copy. Check the provider’s terms before using an optional feature.</p>
    <h2>Access records</h2><p>For free visitors, the service records daily web and desktop access counts. To limit automated abuse when access is created, it uses a hashed network address and request time to limit new access over a rolling 24-hour window. Existing named access can have its own activity counts. Hosting and data providers also process the network requests needed to run the app.</p>
    <h2>Clearing browser data</h2><p>Clearing site storage removes the local access ID and local data. You may lose the ability to reconnect to the existing server copy. Clearing your browser does not automatically delete data already copied to the server.</p>
  </SiteShell>
}
