// HRail (plan Task 15) — the T212-Discover-style horizontal snap-scroll rail
// shared by Top movers / Top losers / Sectors on the Stocks screen. A rail's
// data must cost NOTHING at boot: `onVisible` fires exactly once, the first
// time this rail's section scrolls into the viewport (IntersectionObserver),
// and the caller is trusted to gate its own fetch behind that — HRail itself
// never touches the network, never calls a fetcher, never reads a slice.

import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'wouter'

export function HRail({
  title,
  seeAllPath,
  onVisible,
  children,
}: {
  title: string
  seeAllPath: string
  onVisible: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLElement | null>(null)
  // ref'd so the observer effect below mounts ONCE — a fresh inline closure
  // from the caller every render must never tear down and recreate the
  // IntersectionObserver (that would risk missing the one intersection that
  // matters, or double-firing).
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let fired = false
    const io = new IntersectionObserver(entries => {
      if (fired) return
      if (entries.some(e => e.isIntersecting)) {
        fired = true
        onVisibleRef.current()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <section className="stx-rail-section" ref={ref} aria-label={title}>
      <div className="stx-rail-head">
        <span className="sec-label" style={{ margin: 0 }}>
          {title}
        </span>
        <Link href={seeAllPath} className="stx-seeall">
          See all
        </Link>
      </div>
      <div className="hrail">{children}</div>
    </section>
  )
}
