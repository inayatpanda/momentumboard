import { describe, it, expect } from 'vitest'
import { loadUniverseSeed, loadUniverseSeedFile, seedSizeShortfall, SEED_MIN_SHARE } from './universeSeed'
import {
  accumulate,
  bandForIndexes,
  cleanCell,
  extractTables,
  largestBand,
  normaliseSymbol,
  normaliseUkSymbol,
  normaliseUsSymbol,
  parseCsv,
  pickConstituentTable,
  sortRows,
  INDEX_BAND,
  INDEX_ORDER,
  SYMBOL_RE,
  type IndexTag,
  type UniverseSeedRow,
} from './universeSeedBuild'

// ---------------------------------------------------------------------------
// The committed seed
// ---------------------------------------------------------------------------

describe('the committed universe seed', () => {
  const rows = loadUniverseSeed()

  it('loads and carries a full universe', () => {
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(1200)
  })

  it('stamps a header whose count matches the rows it shipped', () => {
    const file = loadUniverseSeedFile()
    expect(file.count).toBe(rows.length)
    expect(Number.isNaN(Date.parse(file.generatedAt))).toBe(false)
    expect(Object.keys(file.sources).length).toBeGreaterThan(0)
  })

  // A truncated seed is the QUIET failure: the scan runs, the universe is a
  // third of its size, every missing name is simply never looked at, and the
  // only evidence is a smaller number in a log line. The floor turns that into
  // a refusal — one legacy-path run, with a sentence saying why.
  describe('the seed-size floor', () => {
    it('the committed file clears it, and loading does not throw', () => {
      const file = loadUniverseSeedFile()
      expect(seedSizeShortfall(file.rows.length, file.count)).toBeNull()
      expect(() => loadUniverseSeed()).not.toThrow()
    })

    it('refuses a file that lost more than 15% of its committed count', () => {
      // 1,866 × 0.85 = 1,586.1, so 1,587 is the first row count that passes.
      expect(seedSizeShortfall(Math.ceil(1_866 * SEED_MIN_SHARE), 1_866)).toBeNull()
      expect(seedSizeShortfall(1_586, 1_866)).toMatch(/truncated/)
      expect(seedSizeShortfall(1_866, 1_866)).toBeNull()
      const bad = seedSizeShortfall(620, 1_866)
      expect(bad).toMatch(/620 rows/)
      expect(bad).toMatch(/committed count of 1866/)
      expect(seedSizeShortfall(0, 1_866)).toMatch(/truncated/)
    })

    it('a file with no header count is not judged — there is nothing to judge it against', () => {
      expect(seedSizeShortfall(3, undefined)).toBeNull()
      expect(seedSizeShortfall(3, 0)).toBeNull()
    })
  })

  it('has no duplicate symbols', () => {
    const seen = new Map<string, number>()
    for (const r of rows) seen.set(r.sym, (seen.get(r.sym) ?? 0) + 1)
    const dupes = [...seen].filter(([, n]) => n > 1).map(([s]) => s)
    expect(dupes).toEqual([])
  })

  it('every symbol is Yahoo-shaped', () => {
    const bad = rows.filter(r => !SYMBOL_RE.test(r.sym)).map(r => r.sym)
    expect(bad).toEqual([])
  })

  it('every row has a capBand, an exchange and at least one index tag', () => {
    const bad = rows.filter(
      r =>
        !['large', 'mid', 'small'].includes(r.capBand) ||
        !['US', 'LSE'].includes(r.exchange) ||
        !Array.isArray(r.index) ||
        r.index.length === 0,
    )
    expect(bad.map(r => r.sym)).toEqual([])
  })

  it('UK rows end with .L and US rows do not', () => {
    const ukBad = rows.filter(r => r.exchange === 'LSE' && !r.sym.endsWith('.L')).map(r => r.sym)
    const usBad = rows.filter(r => r.exchange === 'US' && r.sym.includes('.')).map(r => r.sym)
    expect(ukBad).toEqual([])
    expect(usBad).toEqual([])
    expect(rows.filter(r => r.exchange === 'LSE').length).toBeGreaterThan(0)
  })

  it('capBand agrees with the largest band its index tags confer', () => {
    const bad = rows.filter(r => r.capBand !== bandForIndexes(r.index)).map(r => r.sym)
    expect(bad).toEqual([])
  })

  it('is sorted by symbol, so a regeneration diffs cleanly', () => {
    expect(rows.map(r => r.sym)).toEqual(sortRows(rows).map(r => r.sym))
  })

  it('emits index tags in the canonical order', () => {
    const bad = rows
      .filter(r => r.index.join('|') !== INDEX_ORDER.filter(t => r.index.includes(t)).join('|'))
      .map(r => r.sym)
    expect(bad).toEqual([])
  })

  it('contains the spot-check names', () => {
    const syms = new Set(rows.map(r => r.sym))
    for (const s of ['AAPL', 'GLW', 'RR.L', 'BP.L']) expect(syms.has(s), s).toBe(true)
  })

  it('covers US large/mid/small and UK large/mid', () => {
    const key = (r: UniverseSeedRow) => `${r.exchange}:${r.capBand}`
    const have = new Set(rows.map(key))
    for (const k of ['US:large', 'US:mid', 'US:small', 'LSE:large', 'LSE:mid']) {
      expect(have.has(k), k).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Symbol normalisation
// ---------------------------------------------------------------------------

describe('normaliseUsSymbol', () => {
  it('passes a plain ticker through', () => {
    expect(normaliseUsSymbol('AAPL')).toBe('AAPL')
    expect(normaliseUsSymbol(' glw ')).toBe('GLW')
  })

  it('rewrites a share-class dot as a dash', () => {
    expect(normaliseUsSymbol('BRK.B')).toBe('BRK-B')
    expect(normaliseUsSymbol('BF.B')).toBe('BF-B')
  })

  it('strips footnote markers, whitespace and zero-width junk', () => {
    expect(normaliseUsSymbol('MMM[1]')).toBe('MMM')
    expect(normaliseUsSymbol('A A​PL')).toBe('AAPL')
    expect(normaliseUsSymbol('BRK.B [note 2]')).toBe('BRK-B')
  })

  it('drops a trailing dot rather than turning it into a dangling dash', () => {
    expect(normaliseUsSymbol('RR.')).toBe('RR')
  })

  it('refuses anything that is not a ticker', () => {
    expect(normaliseUsSymbol('')).toBeNull()
    expect(normaliseUsSymbol('   ')).toBeNull()
    expect(normaliseUsSymbol('[1]')).toBeNull()
    expect(normaliseUsSymbol('Alcoa Corporation')).toBeNull()
    expect(normaliseUsSymbol('ABCDEFGHIJKL')).toBeNull()
  })
})

describe('normaliseUkSymbol', () => {
  it('suffixes .L', () => {
    expect(normaliseUkSymbol('BP')).toBe('BP.L')
    expect(normaliseUkSymbol('3IN')).toBe('3IN.L')
    expect(normaliseUkSymbol('N91')).toBe('N91.L')
  })

  it('turns an internal dot into a dash before suffixing', () => {
    expect(normaliseUkSymbol('BT.A')).toBe('BT-A.L')
  })

  it('drops a trailing dot (Rolls-Royce is written RR. upstream)', () => {
    expect(normaliseUkSymbol('RR.')).toBe('RR.L')
    expect(normaliseUkSymbol('RR')).toBe('RR.L')
  })

  it('does not double-suffix an already-Yahoo symbol', () => {
    expect(normaliseUkSymbol('BP.L')).toBe('BP.L')
    expect(normaliseUkSymbol('bt.a.l')).toBe('BT-A.L')
  })

  it('refuses junk', () => {
    expect(normaliseUkSymbol('')).toBeNull()
    expect(normaliseUkSymbol('[12]')).toBeNull()
    expect(normaliseUkSymbol('Rolls-Royce Holdings')).toBeNull()
  })

  it('every output it produces satisfies the seed symbol shape', () => {
    for (const raw of ['BP', 'BT.A', 'RR.', '3IN', 'N91', 'RS1']) {
      expect(SYMBOL_RE.test(normaliseUkSymbol(raw)!)).toBe(true)
    }
  })
})

describe('normaliseSymbol', () => {
  it('routes by exchange', () => {
    expect(normaliseSymbol('BRK.B', 'US')).toBe('BRK-B')
    expect(normaliseSymbol('BT.A', 'LSE')).toBe('BT-A.L')
  })
})

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

describe('cap bands', () => {
  it('maps each index to its band', () => {
    expect(INDEX_BAND.sp500).toBe('large')
    expect(INDEX_BAND.ndx).toBe('large')
    expect(INDEX_BAND.ftse100).toBe('large')
    expect(INDEX_BAND.sp400).toBe('mid')
    expect(INDEX_BAND.ftse250).toBe('mid')
    expect(INDEX_BAND.sp600).toBe('small')
  })

  it('keeps the largest band when a name sits in several indexes', () => {
    expect(largestBand('small', 'large')).toBe('large')
    expect(largestBand('mid', 'small')).toBe('mid')
    expect(bandForIndexes(['sp600', 'sp500'])).toBe('large')
    expect(bandForIndexes(['sp400', 'sp600'])).toBe('mid')
    expect(bandForIndexes([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

describe('accumulate', () => {
  const raw = (sym: string, index: IndexTag, name = 'N', sector: string | null = 'Tech') =>
    ({ sym, name, sector, index })

  it('unions index tags in canonical order and keeps the largest band', () => {
    const merged = accumulate([raw('AAPL', 'ndx'), raw('AAPL', 'sp500')])
    const row = merged.get('AAPL')!
    expect(row.index).toEqual(['sp500', 'ndx'])
    expect(row.capBand).toBe('large')
  })

  it('never lets a later source blank a field an earlier one filled', () => {
    const merged = accumulate([raw('X', 'sp500', 'Full Name', 'Health Care'), raw('X', 'ndx', '', null)])
    const row = merged.get('X')!
    expect(row.name).toBe('Full Name')
    expect(row.sector).toBe('Health Care')
  })

  it('backfills a sector a first source did not have', () => {
    const merged = accumulate([raw('Y', 'ndx', 'Y Inc', null), raw('Y', 'sp500', 'Y Inc', 'Utilities')])
    expect(merged.get('Y')!.sector).toBe('Utilities')
  })

  it('tags the exchange from the index', () => {
    const merged = accumulate([raw('BP.L', 'ftse100'), raw('AAPL', 'sp500')])
    expect(merged.get('BP.L')!.exchange).toBe('LSE')
    expect(merged.get('AAPL')!.exchange).toBe('US')
  })
})

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('handles quotes, embedded commas and CRLF', () => {
    const rows = parseCsv('Symbol,Security,GICS Sector\r\nMMM,3M,Industrials\r\nAOS,"A. O. Smith, Inc.",Industrials\r\n')
    expect(rows[0]).toEqual(['Symbol', 'Security', 'GICS Sector'])
    expect(rows[2]).toEqual(['AOS', 'A. O. Smith, Inc.', 'Industrials'])
    expect(rows).toHaveLength(3)
  })

  it('handles doubled quotes and a BOM', () => {
    expect(parseCsv('﻿a,"say ""hi"""')).toEqual([['a', 'say "hi"']])
  })
})

describe('cleanCell', () => {
  it('decodes entities and removes footnote markers', () => {
    expect(cleanCell('<td>S&amp;P&nbsp;Global<sup>[3]</sup></td>')).toBe('S&P Global')
  })
})

describe('extractTables / pickConstituentTable', () => {
  const page = `
    <table class="wikitable sortable"><tr><th>Date</th><th>Added</th></tr>
      ${Array.from({ length: 80 }, (_, i) => `<tr><td>d${i}</td><td>a${i}</td></tr>`).join('')}
    </table>
    <table class="wikitable sortable sticky-header">
      <tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>SEC filings</th></tr>
      ${Array.from({ length: 60 }, (_, i) => `<tr><td>S${i}</td><td>Name ${i}</td><td>Tech</td><td>reports</td></tr>`).join('')}
    </table>
    <table class="navbox"><tr><td>nav</td></tr></table>`

  it('reads the header and rows of every table', () => {
    const tables = extractTables(page)
    expect(tables).toHaveLength(3)
    expect(tables[1].header).toEqual(['Symbol', 'Security', 'GICS Sector', 'SEC filings'])
    expect(tables[1].rows).toHaveLength(60)
  })

  it('picks the constituents table by header shape, not by ordinal', () => {
    const picked = pickConstituentTable(extractTables(page), 40)!
    expect(picked.symbolIdx).toBe(0)
    expect(picked.nameIdx).toBe(1)
    expect(picked.sectorIdx).toBe(2)
    expect(picked.rows).toHaveLength(60)
  })

  it('reads a FTSE-shaped table where the ticker is the SECOND column', () => {
    const ftse = `<table class="wikitable sortable">
      <tr><th>Company</th><th>Ticker</th><th>FTSE industry classification benchmark sector<sup>[39]</sup></th></tr>
      ${Array.from({ length: 50 }, (_, i) => `<tr><td>Co ${i}</td><td>T${i}</td><td>Financial Services</td></tr>`).join('')}
    </table>`
    const picked = pickConstituentTable(extractTables(ftse), 40)!
    expect(picked.symbolIdx).toBe(1)
    expect(picked.nameIdx).toBe(0)
    expect(picked.sectorIdx).toBe(2)
  })

  it('does not choke on a nested table', () => {
    const nested = `<table class="wikitable"><tr><th>Symbol</th><th>Security</th></tr>
      <tr><td>A</td><td><table class="navbox"><tr><td>inner</td></tr></table>Alpha</td></tr></table>`
    const tables = extractTables(nested)
    expect(tables[0].header).toEqual(['Symbol', 'Security'])
    expect(tables[0].rows).toEqual([['A', 'Alpha']])
  })

  it('returns null when the page has lost its constituents table', () => {
    expect(pickConstituentTable(extractTables('<table class="wikitable"><tr><th>Year</th><th>Close</th></tr></table>'), 40)).toBeNull()
  })
})
