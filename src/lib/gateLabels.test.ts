// gateLabels (plan Task 14): every gate code the engine can refuse or publish
// with must read as a short human phrase, never the raw code. The `satisfies
// Record<GateCode, string>` in gateLabels.ts is the compile-time net (a new
// GateCode with no entry is a TYPE error); this file is the runtime net — a
// hand-typed copy of the union so a label that IS present but empty, or a key
// typo'd against the union, still fails a test rather than shipping quietly.

import { describe, expect, it } from 'vitest'
import { GATE_LABELS } from './gateLabels'
import type { GateCode } from '../../shared/engine/types'

// Hand-typed against shared/engine/types.ts:184-210 — every member of GateCode.
const ALL_GATE_CODES: GateCode[] = [
  'not-candidate',
  'crypto-contained',
  'trimmed',
  'no-candles',
  'no-data',
  'dead-zone-core',
  'dead-zone-context',
  'capacity-data',
  'expected-move',
  'entry-wait',
  'entry-chase',
  'entry-reversal',
  'evidence-fail',
  'dip-refused',
  'grade-watchonly',
  'route-blocked',
  'diversity',
  'slot-cut',
  'shadow-capped',
  'called-full',
  'called-half',
  'called-shadow',
  'called-watch',
  'called-below-base',
  'called-observation',
  'called-wildcard',
]

describe('GATE_LABELS', () => {
  it('covers every member of the GateCode union with a non-empty phrase', () => {
    for (const code of ALL_GATE_CODES) {
      expect(GATE_LABELS[code], `missing/empty label for ${code}`).toBeTruthy()
      expect(typeof GATE_LABELS[code]).toBe('string')
      expect(GATE_LABELS[code].trim().length).toBeGreaterThan(0)
    }
  })

  it('has exactly one entry per code — no stray keys', () => {
    expect(Object.keys(GATE_LABELS).sort()).toEqual([...ALL_GATE_CODES].sort())
  })

  it('never just echoes the raw gate code back', () => {
    for (const code of ALL_GATE_CODES) {
      expect(GATE_LABELS[code]).not.toBe(code)
    }
  })

  it('specific honest phrasings the reviewer will spot-check', () => {
    expect(GATE_LABELS['dead-zone-core']).toMatch(/conviction/i)
    expect(GATE_LABELS['entry-chase']).toMatch(/chase/i)
    expect(GATE_LABELS['slot-cut']).toMatch(/slot/i)
    expect(GATE_LABELS['no-candles']).toMatch(/chart/i)
    expect(GATE_LABELS['called-full']).toMatch(/full size/i)
  })
})
