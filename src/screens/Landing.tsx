import { SiteNav } from './SitePages'

// LANDING: the public face of the paper — everything a visitor without a licence
// key sees. It borrows the app's own broadsheet identity (serif masthead, gold
// accent, section rules, the .card surface, the .gate unlock card) so the door
// and the room behind it read as one product. Licence-holders unlock here with
// the same mechanic as the in-app gate: setToken(key) → onUnlocked().

type Feature = { title: string; body: string }

const FEATURES: Feature[] = [
  {
    title: 'The Morning Paper',
    body: 'A pre-market edition in your inbox with a PDF print copy — the tape, the board, rotations and new listings, set before the open.',
  },
  {
    title: 'An engine that grades itself',
    body: 'Every call is probability-scored, tracked against SPY and published to a lifetime ledger — the hits and, in full, the misses.',
  },
  {
    title: 'Catalyst-aware',
    body: 'Major news, IPO debuts and sector rotations become candidates the day they matter — large caps included, not just the momentum tail.',
  },
  {
    title: 'The Desk & Quant decks',
    body: 'Wide dashboards built for big screens: a two-sleeve board, live levels on charts, sector heat, calibration curves and 13F flow.',
  },
  {
    title: 'Pundit accountability',
    body: 'YouTube and Reddit stock-callers are tracked and credibility-scored against reality before their picks can touch the board.',
  },
  {
    title: 'Alerts where you live',
    body: 'Telegram bulletins, push notifications and a two-way bot — the edition finds you, wherever you already are.',
  },
]

export function Landing({ onUnlocked, licensed = false }: { onUnlocked: () => void; licensed?: boolean }) {
  const openApp = () => { if (licensed) onUnlocked(); else location.assign('/app/') }

  return (
    <div className="landing">
      <div className="landing-col">
        {/* 1 — Masthead */}
        <header className="landing-masthead">
          <h1 className="landing-nameplate">
            The Street <span>Signal</span>
          </h1>
          <p className="landing-tagline">
            A daily engine-built market paper — calls, calibration, and an honest ledger.
          </p>
          <SiteNav active="home" />
        </header>

        {/* 2 — Hero */}
        <section className="landing-hero">
          <p className="landing-hero-line">The market, read like a paper. Graded like a quant.</p>
          <p className="landing-hero-sub">
            The engine composes a morning edition, makes calibrated calls, and grades itself in
            public — every call lands in a ledger, hit or miss.
          </p>
          <div className="landing-hero-actions">
            <button className="landing-hero-primary" onClick={openApp}>
              Open the app
            </button>
            <a className="landing-hero-secondary" href="#access">I already have access</a>
          </div>
          <div className="landing-proof" aria-label="How StreetSignal is measured">
            <span><b>5 &amp; 10 session</b> grading</span>
            <span><b>SPY-relative</b> outcomes</span>
            <span><b>Every miss</b> stays visible</span>
          </div>
        </section>

        {/* 3 — Feature grid */}
        <section className="landing-section">
          <div className="section-title landing-rule">What lands on the page</div>
          <div className="landing-grid">
            {FEATURES.map(f => (
              <article key={f.title} className="landing-feature">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* 4 — Get the app: free downloads; the licence gate lives INSIDE the
            app, so an open download is still a gated reader on first launch */}
        <section className="landing-section">
          <div className="section-title landing-rule">Take it with you</div>
          <div className="site-downloads">
            <a className="dl-btn" href="/download/mac">
              <b>Mac app</b>
              <span>Apple&nbsp;Silicon (M-series Macs)</span>
            </a>
            <a className="dl-btn" href="/download/win">
              <b>Windows app</b>
              <span>one-click installer</span>
            </a>
            <div className="dl-btn dl-note">
              <b>Phone</b>
              <span>open this site → Install app (Android) or Share → Add to Home Screen (iPhone)</span>
            </div>
          </div>
          <p className="landing-honesty" style={{ marginTop: 10 }}>
            Free to download — the friends-preview password opens the app on each device.
          </p>
        </section>

        {/* 5 — Honesty strip */}
        <p className="landing-honesty">
          Calibrated analysis, not advice. The ledger shows everything — including what went wrong.
        </p>

        {/* 5 — Unlock (the gate) */}
        <section className="landing-unlock" id="access">
          <div className="landing-gate-card">
            <h2>Reader access</h2>
            <p>
              StreetSignal is currently in a private friends preview. Open the app and enter the shared password once on each device.
            </p>

            {licensed ? (
              <>
                {/* the licensed reader browsing the public site — no gate, just the way back */}
                <button className="landing-trial-btn" onClick={onUnlocked}>Open the app</button>
                <p className="landing-trial-note">This device already has access — you were viewing the public site.</p>
              </>
            ) : (
              <>
                <button className="landing-trial-btn" onClick={openApp}>Enter the friends preview</button>
                <p className="landing-trial-note">No signup and no individual licence. Ask the person who shared StreetSignal with you for the current preview password.</p>
              </>
            )}
          </div>
        </section>

        {/* 6 — Footer */}
        <footer className="landing-footer">© The Street Signal · informs, does not predict</footer>
      </div>
    </div>
  )
}
