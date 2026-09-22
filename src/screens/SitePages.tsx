import type { ReactNode } from 'react'

// SITE PAGES: the public website beyond the front page — how the engine works,
// what the paper carries, how the ledger keeps it honest, and the FAQ. Same
// broadsheet identity as the Landing (masthead, gold accent, section rules);
// plain <a> navigation because these are real URLs (netlify.toml catch-all
// serves index.html and App.tsx routes the path). No licence required to read.

export type SitePage = 'home' | 'engine' | 'paper' | 'ledger' | 'faq'

const NAV: { page: SitePage; path: string; label: string }[] = [
  { page: 'home', path: '/', label: 'Front page' },
  { page: 'engine', path: '/engine', label: 'The Engine' },
  { page: 'paper', path: '/paper', label: 'The Paper' },
  { page: 'ledger', path: '/ledger', label: 'The Ledger' },
  { page: 'faq', path: '/faq', label: 'FAQ' },
]

export function siteRouteFor(pathname: string): SitePage {
  if (pathname.startsWith('/engine')) return 'engine'
  if (pathname.startsWith('/paper')) return 'paper'
  if (pathname.startsWith('/ledger')) return 'ledger'
  if (pathname.startsWith('/faq')) return 'faq'
  return 'home'
}

export function SiteNav({ active }: { active: SitePage }) {
  return (
    <nav className="site-nav" aria-label="Site">
      {NAV.map(n => (
        <a key={n.page} href={n.path} className={active === n.page ? 'is-active' : ''} aria-current={active === n.page ? 'page' : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  )
}

function SiteShell({ active, title, kicker, children }: { active: SitePage; title: string; kicker: string; children: ReactNode }) {
  return (
    <div className="landing">
      <div className="landing-col">
        <header className="landing-masthead">
          <h1 className="landing-nameplate">
            <a href="/" style={{ color: 'inherit', textDecoration: 'none' }}>
              The Street <span>Signal</span>
            </a>
          </h1>
          <SiteNav active={active} />
        </header>

        <section className="landing-hero site-page-hero">
          <p className="site-kicker">{kicker}</p>
          <p className="landing-hero-line">{title}</p>
        </section>

        <div className="site-prose">{children}</div>

        <section className="landing-unlock site-page-cta">
          <div className="landing-gate-card">
            <h2>Read it live</h2>
            <p>A 7-day reader pass for this device — no card, no signup.</p>
            <a className="landing-trial-btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }} href="/#access">
              Start free access — 7 days
            </a>
          </div>
        </section>

        <footer className="landing-footer">© The Street Signal · informs, does not predict</footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- The Engine

export function EnginePage() {
  return (
    <SiteShell active="engine" kicker="Under the bonnet" title="A signal engine that has to earn every call.">
      <h2>Three layers, strictly separated</h2>
      <p>
        Most stock pickers blur discovery, opinion and evidence into one score. StreetSignal keeps them apart, and only one of the
        three is ever allowed to decide a trade.
      </p>
      <h3>1 · Discovery — who gets examined</h3>
      <p>
        Screeners, social chatter, headline catalysts, sector rotation, fresh IPO listings, tracked YouTube channels and 13F filings
        all do the same, limited job: they <em>nominate</em> tickers for the engine to look at. A nomination is never a call. Every
        candidate — a Reddit favourite or a megacap in the news — faces the same gates, the same factor stack, the same grading.
      </p>
      <h3>2 · The core signal — what decides direction</h3>
      <p>
        Direction and eligibility come only from repeatable, point-in-time market data: the chart's technical stage, momentum
        relative to the S&amp;P 500, sector strength, seasonal tendency, volume confirmation, market breadth and regime. Before a call
        can act it must satisfy a minimum evidence contract — technical and momentum readable, the market regime known, at least one
        confirming leg, and at least two independent signal families agreeing. A call that misses the contract is not silenced: if the
        conviction is genuinely there it trades at half size with the missing leg named on the card, and only when conviction is thin
        as well does it drop to a watch-only observation.
      </p>
      <h3>3 · Context — colour, capped</h3>
      <p>
        News tone, social heat, pundit stances, insider buys and 13F moves add conviction colour — hard-capped so that all of it
        together can never create a call, flip its direction, or turn a weak chart into a long because of a loud headline. A live
        catalyst can win a name a fair look on the day the news breaks; it cannot buy it a free pass.
      </p>

      <h2>Grades that mean something</h2>
      <p>
        Every published call carries a probability calibrated on the engine's own graded history — not a vibe, a bucket of past
        outcomes. The <em>letter</em> beside it answers the question that probability alone cannot: how much better is this than an
        ordinary candidate? So the letter is measured against a <b>grade bar</b> — the rate at which any name the engine screens
        clears the same test, swept over years of history and then held still. A <b>C</b> clears that bar, a <b>B</b> clears it by
        five points, an <b>A</b> by ten with enough graded history underneath to mean it. The bar does not drift with the engine's
        mood or with a good month: it is measured once, when the engine is seeded from history, and only a re-seed can move it.
      </p>
      <p>
        The bar holding still does not mean the letters do. A grade can shift when the evidence underneath it is re-partitioned — the
        engine deciding a call should be priced against a narrower, truer slice of its own record — or when one of the gates the calls
        must pass moves a notch. Those are the only two ways it happens, and neither is quiet: a gate move is announced in the morning
        paper on the day it is taken, and an evidence shift shows up as the numbers themselves, in the probability on the card and in
        the calibration plot that checks it.
      </p>
      <p>
        Size then follows conviction <em>and</em> evidence together, in three tiers. <b>A</b> or <b>B</b> on the full
        evidence contract is a full-size trade — at most three per side per day, each with entry, invalidation, target and the risk
        the engine's track record has earned. When exactly one of the two is short — a <b>C</b> that clears the full contract, or an
        A/B whose evidence is thin — the call still trades, at <b>half size</b>, with the gap it is missing named on the card. Only
        when conviction and evidence are both short — a C on thin evidence, or a setup priced below the grade bar — does
        the row publish watch-only: visible, graded, learning, carrying no size.
      </p>
      <p>
        On a morning when a side carries nothing tradeable, the board still refuses to go blank — and it says which reason is the true
        one. When nothing cleared the gates, it names the <b>nearest misses</b>, the reads that came closest, for exactly
        what they are: no letter grade, no probability, no size, and they never enter the ledger. When something did clear every gate
        and simply cannot be routed inside an ISA — the usual fate of a short with no inverse ETP — it says that instead, and shows
        the call as an observation. And when the side is empty because the engine's own <b>dip read</b> outranked the short it had on
        that chart, it says that too, rather than blaming gates that were passed. Either way it is the engine's "no", said out loud.
        "No qualified trades" is a result, not a failure.
      </p>
      <p>
        Calls also carry a setup family — trend continuation, pullback/reversal, exhaustion fade — and the family is no longer only a
        stamp on the card. Once a family has thirty graded outcomes from calls that were actually <em>sized</em>, it earns a curve of
        its own, read at that call's own conviction, and that reading becomes <b>30%</b> of the published probability; the engine's
        pooled ladder is the other 70%. Below thirty the family stays silent rather than guessing, and the curve only ever rises with
        conviction, so a stronger read can never be priced lower than a weaker one. A breakout long and a knife-catch fail in
        different ways, and their records are never allowed to blur.
      </p>

      <h2>Both directions, honestly</h2>
      <p>
        The engine shorts. A rolled-over chart in a red tape is a call, not a footnote — with the same grading discipline, and an
        executable route via inverse ETPs once the risk ladder unlocks it. Until then a short is published paper-only and graded all
        the same.
      </p>

      <h2>Risk that is earned, not assumed</h2>
      <p>
        Position size comes from a risk ladder with four rungs. The ladder climbs only on evidence — a full window of graded calls,
        a hit rate that clears the bar, calibration improving — and steps down fast when the record goes cold. Large-cap and
        small-cap sleeves each earn their own rung. Every change writes its reason into the record.
      </p>
    </SiteShell>
  )
}

// ---------------------------------------------------------------- The Paper

export function PaperPage() {
  return (
    <SiteShell active="paper" kicker="The morning edition" title="A market paper written by an engine, edited by its own ledger.">
      <h2>Before the open</h2>
      <p>
        Each trading morning the engine composes a full edition: the overnight world tape read from Asia and Europe into US futures,
        the market regime, sector rotation, and the day's board — every call typeset with its grade, probability, entry,
        invalidation and target. It lands in the app and by email, with a print-styled PDF for reading away from a screen.
      </p>
      <h2>A journalist on a short leash</h2>
      <p>
        A language model writes the prose — the case for each idea, the chart read, what the street is saying. It is a journalist,
        not an analyst: it may only write about calls the engine actually made, and every number is copied from the board, never
        composed. It gets exactly one qualitative power — flagging an idea with a boost, a caution or a veto grounded in a real
        headline — and every use of that power is logged and graded against what price then did.
      </p>
      <p>
        The words are on a leash too. Every call reaches the paper already carrying its own one-sentence thesis — what the engine
        believes and why, written by the engine, in English rather than in its own field names — and the sentence that would prove
        it wrong. The journalist polishes the first and may never replace it; the second is printed exactly as the engine wrote it,
        in the invalidation line. You should never have to guess what a call is claiming, or what would end it.
      </p>
      <h2>Intel that outlives the day</h2>
      <ul>
        <li>Congress trading — disclosed buys and sells, rolled up by politician and sector, scored against the S&amp;P.</li>
        <li>Insider clusters — multiple executives buying their own stock at once.</li>
        <li>13F smart money — what tracked funds did last filing, dated honestly (up to 45 days stale, and weighted accordingly).</li>
        <li>Pundit accountability — tracked YouTube channels' calls graded by the same yardstick as the engine's own.</li>
        <li>New listings, earnings calendar, and the themes actually moving in the news.</li>
      </ul>
      <h2>It finds you</h2>
      <p>
        Telegram bulletins before the open and after the close, push notifications for the edition, and an intraday ping if an open
        call touches its published stop or target. The paper reads the same on a phone, a tablet, or the wide Desk view built for a
        desktop monitor.
      </p>
    </SiteShell>
  )
}

// ---------------------------------------------------------------- The Ledger

export function LedgerPage() {
  return (
    <SiteShell active="ledger" kicker="The honesty pane" title="Every call is graded in public — including the ones that were wrong.">
      <h2>How a call is scored</h2>
      <p>
        Every published call is measured against what price actually did at 5, 10 and 21 sessions — side-adjusted excess return over
        the S&amp;P 500, from the first tradeable print. Beating the index by a rounding error does not count: a hit must clear a full
        percentage point of excess. Stops are judged on daily closes, so an intraday wick through the level is survivable — but a
        close through it is a miss forever, no matter what happens after.
      </p>
      <h2>Nothing resets, nothing hides</h2>
      <p>
        Outcomes fill calibration buckets that become tomorrow's probabilities, and a lifetime scorecard that never resets. The calls
        the engine suppressed are still graded in the shadows and still learning — but they no longer set the odds on the rows you
        could have acted on. A call that carried real size is priced against the record of calls that carried real size; the shadows
        are priced against the shadows. Nothing is discarded, and nothing a reader was never offered is allowed to flatter the number
        beside something they were. The open book traces every live call daily until its grade lands; the calibration plot shows
        whether a "67%" has actually been hitting 67% of the time.
      </p>
      <h2>The learning loop</h2>
      <p>
        Factors that keep being right slowly earn weight; factors that keep being wrong lose it — all bounded, all evidenced, and
        every factor stays inside a hard band around the weight it was ratified with: never more than half again, and never less
        than half. A long losing record parks a factor at half weight and leaves it there; it can never switch one off. That floor
        is deliberate rather than timid — a self-tuning loop that is allowed to zero its own instruments can stop measuring the
        very thing it was built to measure, and then learn from a record it wrote blind. Weight changes are journalled with the
        evidence that caused them. What does <em>not</em> move while all that happens is the grade bar: it is the market's ordinary odds, measured
        once when the engine is seeded from history and then held fixed, so that an A this quarter means what an A meant last
        quarter. A better engine earns better letters against the same yardstick instead of moving the yardstick with itself — and
        the only thing that can move it is a re-seed, which re-measures the whole thing from the tape.
      </p>
      <h2>Why some days say "no qualified trades"</h2>
      <p>
        The board is small by design: at most three full-size trades per side, and only grades that clear the grade bar — the
        ordinary-candidate rate — by a real margin on full evidence. A call short of one of those two — grade C with the full
        evidence, or an A/B whose evidence is thin — trades
        at half size and says which half is missing. Setups short of both are shown as watch-only observations with no size attached,
        and on a day nothing clears the gates the board names the nearest misses instead of pretending it has a call — while a side
        emptied by routing rather than by the gates is labelled as exactly that. An honest empty board beats seven forced ones — and
        the ledger is what keeps that promise checkable.
      </p>
    </SiteShell>
  )
}

// ---------------------------------------------------------------- FAQ

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is this financial advice?',
    a: 'No. StreetSignal is calibrated analysis with a public track record — it informs, it does not predict or advise. Nothing here is a personal recommendation; do your own research and never risk money you cannot afford to lose.',
  },
  {
    q: 'How do I get access?',
    a: 'StreetSignal is currently a private friends preview. There is no signup or individual licence: open the app and enter the shared preview password once on each device.',
  },
  {
    q: 'Why does it sometimes say "no qualified trades today"?',
    a: 'Because that is the truthful answer. Full size is reserved for A/B grades on full evidence; a grade C that clears the full evidence contract, or an A/B whose evidence is thin, trades at half size with the missing half named. Only when conviction and evidence are both short does a row publish watch-only, with no size. A day with nothing qualified shows the ranked watch list — and if nothing cleared the gates at all, the nearest misses, labelled as misses — instead of dressing weak calls up as trades.',
  },
  {
    q: 'Does the engine really short?',
    a: 'Yes — a breaking-down chart is a call in its own right. Shorts are graded exactly like longs, and carry an executable route via inverse ETPs once the risk ladder has earned it; before that they publish as paper-only analysis.',
  },
  {
    q: 'Where does the data come from?',
    a: 'Price and volume history, screeners, the IPO and earnings calendars, insider filings, 13F filings from EDGAR, congressional disclosures, Reddit and Stocktwits chatter, media headlines, and tracked YouTube channels. External sources nominate and colour — only market data decides.',
  },
  {
    q: 'What does the AI actually do?',
    a: 'It writes prose and reads the news — it never makes calls. The numbers on every card come from the deterministic engine; the language model narrates them, and its one qualitative power (boost/caution/veto on an idea) is logged and graded like everything else.',
  },
  {
    q: 'Can I install it like an app?',
    a: 'Yes, everywhere. Mac and Windows have real installers — free from the front page ("Take it with you"). On Android, open this site and tap Install app; on iPhone, Safari → Share → Add to Home Screen. Use the shared friends-preview password once per device.',
  },
  {
    q: 'What happens when a call goes wrong?',
    a: 'It stays on the record. Misses are graded into the same lifetime ledger as hits, the calibration buckets absorb the loss, and the risk ladder steps down if the record goes cold. The ledger page in the app shows all of it.',
  },
]

export function FaqPage() {
  return (
    <SiteShell active="faq" kicker="Questions" title="Straight answers, in writing.">
      {FAQS.map(f => (
        <details key={f.q} className="site-faq">
          <summary>{f.q}</summary>
          <p>{f.a}</p>
        </details>
      ))}
    </SiteShell>
  )
}
