// New-since marks (dynamism wave, feature 7).

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { countNewSince, flushSeenMarks, isNewSince, noteSeen, readSeenMarks, resetSeenMarks, useNoteSeen, useSeenBaseline, writeSeenMarks } from './lastSeen'

const SEC = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const MS = (iso: string) => Date.parse(iso)

beforeEach(async () => {
  await db.settings.clear()
  resetSeenMarks()
})

describe('the stored marks', () => {
  it('reads as a first visit on a cold store', async () => {
    expect(await readSeenMarks()).toEqual({ boardGeneratedAt: null, newsTopAt: null })
  })

  it('roundtrips, and treats a corrupt row as a first visit rather than throwing', async () => {
    await writeSeenMarks({ boardGeneratedAt: MS('2026-08-17T05:42:00Z'), newsTopAt: SEC('2026-08-17T10:00:00Z') })
    expect(await readSeenMarks()).toEqual({ boardGeneratedAt: MS('2026-08-17T05:42:00Z'), newsTopAt: SEC('2026-08-17T10:00:00Z') })
    await db.settings.put({ key: 'lastSeen', value: 'not json' })
    expect(await readSeenMarks()).toEqual({ boardGeneratedAt: null, newsTopAt: null })
  })

  it('writes what the screens recorded, and a null never erases a mark', async () => {
    noteSeen({ boardGeneratedAt: MS('2026-08-17T05:42:00Z'), newsTopAt: SEC('2026-08-17T10:00:00Z') })
    noteSeen({ boardGeneratedAt: null }) // a screen with no board
    await flushSeenMarks()
    expect((await readSeenMarks()).boardGeneratedAt).toBe(MS('2026-08-17T05:42:00Z'))
  })

  it('a page teardown persists the snapshot', async () => {
    noteSeen({ boardGeneratedAt: 1_755_000_000_000 })
    window.dispatchEvent(new Event('pagehide'))
    await waitFor(async () => expect((await readSeenMarks()).boardGeneratedAt).toBe(1_755_000_000_000))
  })
})

describe('the diff', () => {
  it('is content identity: a newer board is new, the same board re-fetched is not', () => {
    const seen = MS('2026-08-17T05:42:00Z')
    expect(isNewSince(MS('2026-08-18T05:40:00Z'), seen)).toBe(true)
    expect(isNewSince(seen, seen)).toBe(false)
    expect(isNewSince(MS('2026-08-16T05:42:00Z'), seen)).toBe(false)
  })

  it('says nothing is new on a first visit — an install must not shout at the reader', () => {
    expect(isNewSince(MS('2026-08-18T05:40:00Z'), null)).toBe(false)
    expect(countNewSince([SEC('2026-08-18T09:00:00Z')], null)).toBe(0)
  })

  it('counts headlines past the mark, and reads seconds and milliseconds alike', () => {
    const seen = SEC('2026-08-17T09:00:00Z')
    const ats = [SEC('2026-08-17T11:00:00Z'), SEC('2026-08-17T10:00:00Z'), SEC('2026-08-17T08:00:00Z'), null]
    expect(countNewSince(ats, seen)).toBe(2)
    // the same instants in milliseconds compare identically
    expect(countNewSince([MS('2026-08-17T11:00:00Z')], seen)).toBe(1)
    expect(isNewSince(MS('2026-08-17T08:00:00Z'), seen)).toBe(false)
  })
})

function Harness({ board }: { board: number | null }) {
  const baseline = useSeenBaseline()
  useNoteSeen({ boardGeneratedAt: board })
  return <span data-testid="b">{baseline ? String(baseline.boardGeneratedAt) : 'reading'}</span>
}

describe('useSeenBaseline', () => {
  it('reads the marks once and freezes them for the life of the mount', async () => {
    await writeSeenMarks({ boardGeneratedAt: 1, newsTopAt: 2 })
    const { rerender } = render(<Harness board={99} />)
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('1'))
    // the screen has since recorded a newer board — the BASELINE must not move
    await writeSeenMarks({ boardGeneratedAt: 99, newsTopAt: 2 })
    rerender(<Harness board={99} />)
    expect(screen.getByTestId('b').textContent).toBe('1')
  })

  it('what the screen recorded is what a teardown persists', async () => {
    await writeSeenMarks({ boardGeneratedAt: 1, newsTopAt: 2 })
    render(<Harness board={1_755_000_000_000} />)
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('1'))
    await flushSeenMarks()
    // the board moved on; the news mark the baseline seeded is still there
    expect(await readSeenMarks()).toEqual({ boardGeneratedAt: 1_755_000_000_000, newsTopAt: 2 })
  })
})
