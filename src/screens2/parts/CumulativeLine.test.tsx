// The y-axis labels on the cumulative chart: three HTML spans (max, zero,
// min) absolutely positioned beside a stretched SVG. The zero label is a
// COURTESY, not a datum — it may only print when it clears both edge labels.
// Seen live (2026-08-15): a book that dipped to −8.1pp inside a +263pp run
// put the zero line at 93% height and printed "0" straight over "−8.1pp".

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CumulativeLine } from './CumulativeLine'
import type { CumulativePoint } from '../../lib/ledgerSeries'

const pt = (date: string, cumulative: number): CumulativePoint => ({ date, cumulative, daily: cumulative, n: 1 })

const zeroLabel = () => document.querySelector('.rec-chart-yzero')

describe('CumulativeLine y-axis labels', () => {
  it('prints the zero label when zero sits well inside the range', () => {
    render(<CumulativeLine points={[pt('2026-08-01', -10), pt('2026-08-02', 12)]} days={30} />)
    expect(zeroLabel()).not.toBeNull()
  })

  it('suppresses it when the book never went negative — zero IS the minimum', () => {
    render(<CumulativeLine points={[pt('2026-08-01', 4), pt('2026-08-02', 2.5)]} days={30} />)
    expect(zeroLabel()).toBeNull()
  })

  it('suppresses it when a shallow dip pins the zero line onto the min label', () => {
    // min −8.1 in a −8.1..+263.2 range → zero line at ~93% height
    render(<CumulativeLine points={[pt('2026-08-01', -8.1), pt('2026-08-02', 263.2)]} days={30} />)
    expect(zeroLabel()).toBeNull()
  })

  it('suppresses it when a shallow start pins the zero line onto the max label', () => {
    // max +5 in a −200..+5 range → zero line at ~5% height
    render(<CumulativeLine points={[pt('2026-08-01', 5), pt('2026-08-02', -200)]} days={30} />)
    expect(zeroLabel()).toBeNull()
  })
})
