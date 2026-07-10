import { useState } from 'react'
import { setToken, startTrial } from '../lib/api'
import { humanError } from '../lib/format'

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
    body: 'YouTube, Discord and Reddit stock-callers are tracked and credibility-scored against reality before their picks can touch the board.',
  },
  {
    title: 'Alerts where you live',
    body: 'Telegram bulletins, push notifications and a two-way bot — the edition finds you, wherever you already are.',
  },
]

export function Landing({ onUnlocked, licensed = false }: { onUnlocked: () => void; licensed?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const beginTrial = async () => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      await startTrial() // stores the token itself (calls setToken internally)
      onUnlocked()
    } catch (err) {
      setError(humanError(err))
      setPending(false)
    }
  }

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
        </header>

        {/* 2 — Hero */}
        <section className="landing-hero">
          <p className="landing-hero-line">The market, read like a paper. Graded like a quant.</p>
          <p className="landing-hero-sub">
            The engine composes a morning edition, makes calibrated calls, and grades itself in
            public — every call lands in a ledger, hit or miss.
          </p>
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

        {/* 4 — Honesty strip */}
        <p className="landing-honesty">
          Calibrated analysis, not advice. The ledger shows everything — including what went wrong.
        </p>

        {/* 5 — Unlock (the gate) */}
        <section className="landing-unlock">
          <div className="landing-gate-card">
            <h2>Reader access</h2>
            <p>
              StreetSignal is licence-only. Enter your key once — this device stays unlocked.
              Licence-holders: the one-tap unlock link in your welcome message does this
              automatically.
            </p>

            {licensed ? (
              <>
                {/* the licensed reader browsing the public site — no gate, just the way back */}
                <button className="landing-trial-btn" onClick={onUnlocked}>Open the app</button>
                <p className="landing-trial-note">This device is already licensed — you were viewing the public site.</p>
              </>
            ) : (
              <>
                <button className="landing-trial-btn" onClick={beginTrial} disabled={pending}>
                  {pending ? 'Setting up your access…' : 'Start free access — 7 days'}
                </button>
                <p className="landing-trial-note">
                  No card, no signup — a 7-day reader pass for this device. After that, licences are
                  issued privately through the Helm.
                </p>
                {error && <p className="landing-error" role="alert">{error}</p>}

                <div className="landing-or">Already have a licence?</div>
                <form
                  className="landing-key-form"
                  onSubmit={e => {
                    e.preventDefault()
                    const t = new FormData(e.currentTarget).get('t') as string
                    if (t && t.trim()) {
                      setToken(t.trim())
                      onUnlocked()
                    }
                  }}
                >
                  <input name="t" type="password" placeholder="Licence key" autoComplete="off" />
                  <button>Unlock</button>
                </form>
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
