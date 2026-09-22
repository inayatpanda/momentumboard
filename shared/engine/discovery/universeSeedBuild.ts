// PURE helpers for the discovery universe seed. Everything here is offline and
// deterministic — no fetch, no fs, no clock — so `universeSeed.test.ts` can
// exercise the fiddly parts (symbol normalisation, wikitable parsing, CSV
// parsing, band merging) without a network. `scripts/build-universe-seed.ts`
// is the only thing that touches the wire, and it is a thin shell over this.
//
// NOTE on naming: `capBand` here ('large' | 'mid' | 'small') is INDEX
// MEMBERSHIP, not a market-cap measurement. It is deliberately a different
// type from `CapCohort` in ../capClass.ts (which is a $-threshold cohort used
// for calibration): a seed row says "the S&P 400 calls this a midcap", not
// "this company is worth $X".

/** Which venue the Yahoo symbol trades on. Drives the `.L` suffix rule. */
export type Exchange = 'US' | 'LSE'

/** Index-membership band. Largest wins when a name sits in several indexes. */
export type CapBand = 'large' | 'mid' | 'small'

/** The index lists the seed is built from. */
export type IndexTag = 'sp500' | 'ndx' | 'sp400' | 'sp600' | 'ftse100' | 'ftse250'

/** Stable emit order for a row's `index` array — output must not depend on the
 * order the sources happened to come back in. */
export const INDEX_ORDER: readonly IndexTag[] = ['sp500', 'ndx', 'sp400', 'sp600', 'ftse100', 'ftse250']

/** Band each index confers. */
export const INDEX_BAND: Record<IndexTag, CapBand> = {
  sp500: 'large',
  ndx: 'large',
  sp400: 'mid',
  sp600: 'small',
  ftse100: 'large',
  ftse250: 'mid',
}

/** Which exchange each index lives on. */
export const INDEX_EXCHANGE: Record<IndexTag, Exchange> = {
  sp500: 'US',
  ndx: 'US',
  sp400: 'US',
  sp600: 'US',
  ftse100: 'LSE',
  ftse250: 'LSE',
}

const BAND_RANK: Record<CapBand, number> = { large: 3, mid: 2, small: 1 }

/** A name in several indexes keeps the LARGEST band (S&P 500 + Nasdaq-100 →
 * large; a name that somehow appears in both the 400 and the 600 → mid). */
export function largestBand(a: CapBand, b: CapBand): CapBand {
  return BAND_RANK[a] >= BAND_RANK[b] ? a : b
}

/** The band implied by a set of index tags. Empty set → null (caller decides). */
export function bandForIndexes(tags: readonly IndexTag[]): CapBand | null {
  let band: CapBand | null = null
  for (const t of tags) {
    const b = INDEX_BAND[t]
    band = band === null ? b : largestBand(band, b)
  }
  return band
}

/** One validated, tagged universe member. */
export interface UniverseSeedRow {
  /** Yahoo Finance symbol, e.g. `AAPL`, `BRK-B`, `BP.L`, `BT-A.L`. */
  sym: string
  name: string
  exchange: Exchange
  index: IndexTag[]
  sector: string | null
  capBand: CapBand
  /** From Yahoo `chart.result[0].meta` when the validation pass saw it. */
  currency?: string
  exchangeName?: string
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−',
}

/** Decode the handful of HTML entities Wikipedia actually emits, plus numeric
 * refs. Deliberately not a general decoder — it never needs to be. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, n: string) => ENTITIES[n] ?? m)
}

/** Drop tags (and the whole of `<style>`/`<script>`) from a cell's inner HTML. */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
}

/** Cell text → the value we keep: entities decoded, footnote markers (`[12]`,
 * `[a]`, `[note 1]`) removed, zero-width and non-breaking space normalised,
 * runs of whitespace collapsed, trimmed. */
export function cleanCell(raw: string): string {
  return decodeEntities(stripTags(raw))
    .replace(/\[[^\]\n]{0,20}\]/g, '')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Symbol normalisation
// ---------------------------------------------------------------------------

/** Everything that is never part of a ticker: footnotes, spaces, unicode
 * dashes folded to ASCII `-`. Returns '' when nothing usable is left. */
function tickerCore(raw: string): string {
  return cleanCell(raw)
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase()
}

/**
 * US ticker → Yahoo symbol. Yahoo writes share classes with a dash where the
 * exchanges write a dot: `BRK.B` → `BRK-B`, `BF.B` → `BF-B`. A trailing dot
 * (some sources write `RR.`) is a separator with nothing after it, so it goes.
 * Anything that does not end up matching a plausible ticker returns null and
 * is dropped by the caller rather than being half-fixed.
 */
export function normaliseUsSymbol(raw: string): string | null {
  let s = tickerCore(raw)
  if (!s) return null
  s = s.replace(/\.+$/, '').replace(/\./g, '-')
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(s)) return null
  return s
}

/**
 * LSE ticker → Yahoo symbol: suffix `.L`, and internal dots become dashes
 * first (`BT.A` → `BT-A.L`). Trailing dots are dropped (`RR.` → `RR.L`), and
 * an already-suffixed input is not double-suffixed (`BP.L` → `BP.L`).
 */
export function normaliseUkSymbol(raw: string): string | null {
  let s = tickerCore(raw)
  if (!s) return null
  if (s.endsWith('.L')) s = s.slice(0, -2)
  s = s.replace(/\.+$/, '').replace(/\./g, '-')
  if (!/^[A-Z0-9][A-Z0-9-]{0,8}$/.test(s)) return null
  return `${s}.L`
}

/** Exchange-aware front door for the two above. */
export function normaliseSymbol(raw: string, exchange: Exchange): string | null {
  return exchange === 'US' ? normaliseUsSymbol(raw) : normaliseUkSymbol(raw)
}

/** The shape every seed row's `sym` must satisfy — also asserted by the test. */
export const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC4180-ish CSV → rows of cells. Handles quoted fields, doubled quotes,
 * embedded commas/newlines, and CRLF. Ignores a trailing blank line. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.replace(/^﻿/, '')
  while (i < src.length) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i += 1; continue
      }
      field += c; i += 1; continue
    }
    if (c === '"') { quoted = true; i += 1; continue }
    if (c === ',') { row.push(field); field = ''; i += 1; continue }
    if (c === '\r') { i += 1; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue }
    field += c; i += 1
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''))
}

// ---------------------------------------------------------------------------
// HTML tables
// ---------------------------------------------------------------------------

export interface HtmlTable {
  /** The `class` attribute of the `<table>`, lowercased. */
  className: string
  /** First row's cells, cleaned. */
  header: string[]
  /** Every later row's cells, cleaned. */
  rows: string[][]
}

/** Depth-aware `<table>` slicing: a navbox nests tables, and a non-greedy
 * `<table>[\s\S]*?</table>` would truncate at the inner close tag. */
function sliceTables(html: string): string[] {
  const out: string[] = []
  const tag = /<(\/?)table\b[^>]*>/gi
  let depth = 0
  let start = -1
  let m: RegExpExecArray | null
  while ((m = tag.exec(html)) !== null) {
    if (m[1] === '') {
      if (depth === 0) start = m.index
      depth += 1
    } else if (depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        out.push(html.slice(start, m.index + m[0].length))
        start = -1
      }
    }
  }
  return out
}

function cellsOf(rowHtml: string): string[] {
  const cells = rowHtml.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []
  return cells.map(c => cleanCell(c.replace(/^<t[hd]\b[^>]*>/i, '').replace(/<\/t[hd]>$/i, '')))
}

/**
 * Parse every `<table>` in a page into header + rows. Nested tables inside a
 * table's body are stripped before the row split so a navbox's rows never leak
 * into the outer table's.
 */
export function extractTables(html: string): HtmlTable[] {
  return sliceTables(html).map(t => {
    const open = /^<table\b[^>]*>/i.exec(t)?.[0] ?? ''
    const className = (/class="([^"]*)"/i.exec(open)?.[1] ?? '').toLowerCase()
    let body = t.slice(open.length)
    // Strip nested tables (one pass is enough for Wikipedia's depth).
    for (const inner of sliceTables(body)) body = body.split(inner).join('')
    const trs = body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
    const all = trs.map(cellsOf).filter(r => r.length > 0)
    return { className, header: all[0] ?? [], rows: all.slice(1) }
  })
}

/** Keyword sets used to find the columns we want, in priority order. */
const SYMBOL_KEYS = ['symbol', 'ticker', 'epic', 'code']
const NAME_KEYS = ['security', 'company', 'name']
const SECTOR_KEYS = ['sector', 'industry']

function findColumn(header: string[], keys: readonly string[]): number {
  const lower = header.map(h => h.toLowerCase())
  for (const k of keys) {
    const i = lower.findIndex(h => h.includes(k))
    if (i >= 0) return i
  }
  return -1
}

export interface ConstituentTable {
  symbolIdx: number
  nameIdx: number
  sectorIdx: number
  rows: string[][]
}

/**
 * Pick the constituents table out of a Wikipedia page WITHOUT relying on
 * section ids or table ordinals (both of which churn). A table qualifies when
 * it is a `wikitable`, has a symbol-ish AND a name-ish header column, and has
 * at least `minRows` data rows; among the qualifiers the widest one wins, which
 * separates the constituents list from the small "recent changes" tables.
 * Returns null when the page no longer carries such a table — the caller then
 * reports the source as dead and carries on.
 */
export function pickConstituentTable(tables: readonly HtmlTable[], minRows = 40): ConstituentTable | null {
  let best: ConstituentTable | null = null
  for (const t of tables) {
    if (!t.className.includes('wikitable')) continue
    const symbolIdx = findColumn(t.header, SYMBOL_KEYS)
    const nameIdx = findColumn(t.header, NAME_KEYS)
    if (symbolIdx < 0 || nameIdx < 0 || symbolIdx === nameIdx) continue
    const rows = t.rows.filter(r => r.length > Math.max(symbolIdx, nameIdx))
    if (rows.length < minRows) continue
    if (best === null || rows.length > best.rows.length) {
      best = { symbolIdx, nameIdx, sectorIdx: findColumn(t.header, SECTOR_KEYS), rows }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Row accumulation
// ---------------------------------------------------------------------------

/** What a source hands the accumulator before Yahoo validation. */
export interface RawConstituent {
  sym: string
  name: string
  sector: string | null
  index: IndexTag
}

/**
 * Fold constituents from several index lists into one row per symbol: index
 * tags union (emitted in INDEX_ORDER), band = largest, and the first non-empty
 * name/sector wins so a later list cannot blank a field an earlier one filled.
 */
export function accumulate(raws: readonly RawConstituent[]): Map<string, UniverseSeedRow> {
  const out = new Map<string, UniverseSeedRow>()
  for (const r of raws) {
    const exchange = INDEX_EXCHANGE[r.index]
    const band = INDEX_BAND[r.index]
    const prev = out.get(r.sym)
    if (!prev) {
      out.set(r.sym, {
        sym: r.sym,
        name: r.name,
        exchange,
        index: [r.index],
        sector: r.sector && r.sector.length > 0 ? r.sector : null,
        capBand: band,
      })
      continue
    }
    if (!prev.index.includes(r.index)) {
      prev.index = INDEX_ORDER.filter(t => t === r.index || prev.index.includes(t))
    }
    prev.capBand = largestBand(prev.capBand, band)
    if (!prev.name && r.name) prev.name = r.name
    if (prev.sector === null && r.sector) prev.sector = r.sector
  }
  return out
}

/** Deterministic output order: plain ASCII ascending by symbol. */
export function sortRows(rows: readonly UniverseSeedRow[]): UniverseSeedRow[] {
  return [...rows].sort((a, b) => (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0))
}
