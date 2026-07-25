import { describe, it, expect } from 'vitest'
import { fillCallStatus, type EditionCall } from './callStrip'

const marker = (sym: string) => `<span data-call-status="${sym}"></span>`
const calls: EditionCall[] = [
  { sym: 'PATH', side: 'long', entry: 12.0, stop: 11.0, target: 14.0 },
  { sym: 'NRGV', side: 'short', entry: 3.3, stop: 3.6, target: 2.8 },
]

describe('fillCallStatus', () => {
  it('fills a live edition with where the price is now', () => {
    const out = fillCallStatus(`x${marker('PATH')}y`, calls, () => 12.2, { live: true })
    expect(out).toContain('now 12.20')
    expect(out).toContain('+1.7% from entry')
    expect(out).toContain('invalidation 9.8% away') // the paper's own word for the stop
    expect(out).not.toContain('data-call-status')
  })

  // An archived edition must not read as a live recommendation.
  it('an archived edition reads as outcome, not as a live call', () => {
    const out = fillCallStatus(marker('PATH'), calls, () => 12.2, { live: false })
    expect(out).toContain('since this call')
    expect(out).not.toContain('now 12.20')
  })

  it('badges a call that has already run, and one that is invalidated', () => {
    expect(fillCallStatus(marker('PATH'), calls, () => 12.6, { live: true })).toContain('extended')
    expect(fillCallStatus(marker('PATH'), calls, () => 10.8, { live: true })).toContain('through stop')
  })

  it('reads a short in its own direction', () => {
    const out = fillCallStatus(marker('NRGV'), calls, () => 3.14, { live: true })
    expect(out).toContain('+4.8% from entry') // fell 4.8% = your way on a short
  })

  // The paper is also a PDF and an email. A missing quote must leave NOTHING
  // behind, never a broken or half-filled strip.
  it('removes the marker cleanly when there is no price', () => {
    const out = fillCallStatus(`a${marker('PATH')}b`, calls, () => null, { live: true })
    expect(out).toBe('ab')
  })

  it('removes markers for tickers the edition has no levels for', () => {
    expect(fillCallStatus(`a${marker('GONE')}b`, calls, () => 10, { live: true })).toBe('ab')
  })

  it('leaves html without markers exactly as it was', () => {
    const html = '<p>no calls today</p>'
    expect(fillCallStatus(html, calls, () => 12.2, { live: true })).toBe(html)
  })

  // The strip never echoes the ticker, and the marker regex cannot be broken out
  // of with a quote — so a hostile symbol reaches the page as nothing at all.
  it('cannot be used to smuggle html into the page', () => {
    const nasty: EditionCall[] = [{ sym: '<img src=x onerror=alert(1)>', side: 'long', entry: 1, stop: 0.9, target: 1.2 }]
    const out = fillCallStatus(`<span data-call-status="<img src=x onerror=alert(1)>"></span>`, nasty, () => 1.05, { live: true })
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
    expect(out).toContain('from entry') // the strip still renders
  })
})
