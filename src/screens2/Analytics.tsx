import AnalyticsPanels from '../shell/AnalyticsPanels'

/** A routed home for the engine's evidence and learning surfaces. Keeping
 * analytics in normal navigation makes it reachable on phones, preserves
 * browser back/forward, and avoids covering the screen with a slide-over. */
export default function Analytics() {
  return (
    <section className="analytics2" aria-labelledby="analytics-title">
      <header className="analytics2-head">
        <span className="sec-label">Evidence, not promises</span>
        <h1 id="analytics-title">Analytics</h1>
        <p>Explore how accurate past estimates were, seasonal market patterns and reported fund holdings. Open the evidence for the calculations.</p>
      </header>
      <AnalyticsPanels />
    </section>
  )
}
