import { SiteFooter, SiteHeader } from './SitePages'

const FEATURES = [
  { title: 'Keep each strategy separate', body: 'Explore recovery after a big fall, healthy businesses, strong sectors and other approaches. Each has its own stock list and past results.' },
  { title: 'Look beyond the share price', body: 'Check quarterly company results, cash flow, debt and valuation. See whether a falling share price comes with a weakening business.' },
  { title: 'Put the market in context', body: 'Explore how shares, bonds, oil, gold and silver moved in earlier conditions, alongside current news and sector trends.' },
  { title: 'Follow selected YouTube channels', body: 'Read stock findings from selected channels, with source links and coverage labels. Processing gaps stay visible.' },
  { title: 'Know what changed', body: 'Follow stocks you care about and review changes in their price, company reports and surrounding market conditions.' },
  { title: 'Check the evidence', body: 'Compare each tested strategy with the market and its sector. Historical simulations, saved forecasts and current ideas are shown separately.' },
]

// Public calls to action are real links. The app creates browser access when
// /app/ opens; the website never asks visitors to obtain or enter a key.
export function Landing(_props: { onUnlocked?: () => void; licensed?: boolean } = {}) {
  return <main className="landing">
    <div className="landing-col">
      <SiteHeader active="home" />
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <p className="site-kicker">Free stock research, made clearer</p>
          <h1 id="landing-title">Understand the stock.<br /><span>Then decide your next step.</span></h1>
          <p className="landing-hero-sub">Explore ideas, review what you hold and understand what changed. StreetSignal brings company results, market patterns and selected sources into one place.</p>
          <div className="landing-hero-actions"><a className="site-primary" href="/app/">Open the free app</a><a className="site-secondary" href="/engine">See how it works</a></div>
          <p className="landing-access-note">No signup. No payment details. No access key to enter.</p>
        </div>
        <aside className="landing-preview" aria-label="Two ways to use StreetSignal">
          <div className="landing-preview-top"><span>StreetSignal research</span><span>Two clear starting points</span></div>
          <div className="landing-path"><span className="landing-path-number">01</span><div><h2>Buy ideas</h2><p>Find stocks that meet a strategy’s rules.</p><span>Company health · Price trends · Valuation</span></div></div>
          <div className="landing-path"><span className="landing-path-number">02</span><div><h2>Review selling</h2><p>Check whether your reasons for holding still stand.</p><span>Weaker results · Broken trends · Stretched prices</span></div></div>
          <p className="landing-preview-note">Research to review. You make the decision; the app does not place trades.</p>
        </aside>
      </section>
      <section className="landing-facts" aria-label="What is included">
        <div><strong>250 stocks</strong><span>in the shared research universe</span></div><div><strong>Separate strategies</strong><span>with their own rules and results</span></div><div><strong>Runs in the cloud</strong><span>your Mac can be switched off</span></div>
      </section>
      <section className="landing-section" aria-labelledby="research-title">
        <div className="landing-section-head"><p className="site-kicker">Start with a useful question</p><h2 id="research-title">Less noise. More understanding.</h2><p>Plain explanations first. Open “See the evidence” when you want the numbers, sources and limitations.</p></div>
        <div className="landing-grid">{FEATURES.map(feature=><article className="landing-feature" key={feature.title}><h3>{feature.title}</h3><p>{feature.body}</p></article>)}</div>
      </section>
      <section className="landing-free" aria-labelledby="free-title"><div><p className="site-kicker">On your phone or computer</p><h2 id="free-title">Open it. Make it your watchlist.</h2><p>Use the free web app in your browser, or add it to your phone’s home screen. Shared research updates in the cloud without your computer staying on.</p><p className="site-small">Free sources and processing limits can cause delays or missing coverage. Some optional personal AI tools need your own provider key; the shared research does not.</p></div><a className="site-primary" href="/app/">Start exploring</a></section>
      <p className="landing-honesty">A rule match is a starting point for research. Past results do not establish future returns, and StreetSignal does not provide personal financial advice.</p>
      <SiteFooter />
    </div>
  </main>
}
