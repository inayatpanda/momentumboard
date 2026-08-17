// FLIP reorder motion (dynamism wave, feature 8).
//
// jsdom lays nothing out — every getBoundingClientRect is zeros — so the test
// hands the hook its own ruler: a row's position is its index in the order
// being rendered. That is exactly what the hook consumes, and it makes the
// invert step's arithmetic directly assertable.

import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRef } from 'react'
import { FLIP_CLASS, useFlip } from './useFlip'

const ROW_H = 50

function List({ syms, reduced = false }: { syms: string[]; reduced?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFlip(ref, syms.join(','), {
    // position = index in the order CURRENTLY rendered
    measure: el => ({ top: syms.indexOf(el.dataset.flipKey ?? '') * ROW_H, left: 0 }),
    reducedMotion: () => reduced,
  })
  return (
    <div ref={ref}>
      {syms.map(s => (
        <span key={s} data-flip-key={s}>
          {s}
        </span>
      ))}
    </div>
  )
}

const row = (sym: string) => document.querySelector<HTMLElement>(`[data-flip-key="${sym}"]`)!

describe('useFlip', () => {
  it('animates nothing on a first paint — every row is arriving, not moving', () => {
    render(<List syms={['A', 'B', 'C']} />)
    expect(row('A').className).toBe('')
    expect(row('A').style.transform).toBe('')
  })

  it('inverts a moved row to where it came from, and marks it mid-move', () => {
    const { rerender } = render(<List syms={['A', 'B', 'C']} />)
    rerender(<List syms={['C', 'A', 'B']} />)
    // C climbed from index 2 to index 0: it must start 100px BELOW its new home
    expect(row('C')).toHaveClass(FLIP_CLASS)
    expect(row('C').style.transform).toBe('translate(0px, 100px)')
    // A and B each slid down one row, so each starts 50px above
    expect(row('A').style.transform).toBe('translate(0px, -50px)')
    expect(row('B').style.transform).toBe('translate(0px, -50px)')
  })

  it('plays the transform out and cleans up after itself', async () => {
    const { rerender } = render(<List syms={['A', 'B', 'C']} />)
    rerender(<List syms={['C', 'A', 'B']} />)
    expect(row('C').style.transform).not.toBe('')
    await waitFor(() => expect(row('C').style.transform).toBe(''))
    await waitFor(() => expect(row('C').className).toBe(''))
  })

  it('a ranking that did not change moves nothing', () => {
    const { rerender } = render(<List syms={['A', 'B', 'C']} />)
    rerender(<List syms={['A', 'B', 'C']} />)
    expect(row('A').className).toBe('')
    expect(row('B').style.transform).toBe('')
  })

  it('a reader who asked for less motion gets none of it', () => {
    const { rerender } = render(<List syms={['A', 'B', 'C']} reduced />)
    rerender(<List syms={['C', 'A', 'B']} reduced />)
    expect(row('C').className).toBe('')
    expect(row('C').style.transform).toBe('')
    expect(row('A').style.transform).toBe('')
  })

  it('a row that was not there last time simply appears', () => {
    const { rerender } = render(<List syms={['A', 'B']} />)
    rerender(<List syms={['NEW', 'A', 'B']} />)
    expect(row('NEW').className).toBe('')
    expect(row('A')).toHaveClass(FLIP_CLASS) // …while the rows it displaced do move
  })
})
