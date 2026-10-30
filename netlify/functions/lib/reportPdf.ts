import { reportStockName, reportStockLabel } from './reportStockNames'
// The "print edition": a self-contained PDF of the morning paper, composed on
// Netlify with pdf-lib (pure JS — no headless browser, no rendering service, no
// new keys) and attached to the report email. The publish pipe only hands us the
// finished HTML string (see report.mts), so we reconstruct the paper from it:
// strip the tags, keep headings / paragraphs / tables in document order, and
// typeset a clean A4 broadsheet. Everything here is best-effort — report.mts
// wraps the call in try/catch so a PDF failure never blocks the email.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type Color } from 'pdf-lib'
import { boardFootnote, stripLeadingNumber } from './newspaper'
import { plausibleCapUsdM } from './social'
import { WILDCARD_MARK } from '../../../shared/engine/voice'
import type { ComposedReport, PaperExtras, Idea, SocialRow, CalendarRow } from './newspaper'
import { earningsTimeWords } from './weekAhead'

// The structured payload the compose pipe now ships alongside the HTML (see
// report-compose-background.mts). When present we TYPESET the paper from this
// data — real heat cells, sparklines, ruled tables — instead of re-parsing the
// HTML (the old path dropped every <svg> and every stacked <div>). Everything is
// optional and read defensively: a half-empty payload still renders a valid PDF.
export interface ReportPrintData {
  report?: Partial<ComposedReport>
  engineBoard?: PaperExtras['engineBoard']
  sectorBars?: PaperExtras['sectorBars']
  spyCloses?: number[]
  calendar?: PaperExtras['calendar']
  ipos?: PaperExtras['ipos']
  eventRadar?: PaperExtras['eventRadar'] // earnings binaries ahead — the shape going in, never a call
  weekAhead?: PaperExtras['weekAhead'] // Sunday only — the coming Monday-to-Friday
  socialBoard?: PaperExtras['socialBoard']
  // rotation rows arrive slimmed — the per-row sparkline closes are dropped at
  // the payload boundary (bulky), so the print table shows price + 1-week move.
  rotationTables?: { sector: string; etf: string; rows: { sym: string; price: number | null; wkPct: number | null }[] }[]
}

export interface ReportPdfInput {
  html: string
  dateLabel?: string
  print?: ReportPrintData // structured data path; when absent we fall back to htmlToBlocks
}

// ---------- WinAnsi sanitiser ----------
// pdf-lib's StandardFonts speak WinAnsi (CP1252) only: arrows, emoji and
// box-drawing throw at draw time. Map the common offenders to ASCII, then drop
// anything still non-encodable so a stray glyph can never abort the whole PDF.

const SYMBOL_MAP: Record<string, string> = {
  '▲': 'up', '△': 'up', '▴': 'up', '↑': 'up', '⬆': 'up',
  '▼': 'down', '▽': 'down', '▾': 'down', '↓': 'down', '⬇': 'down',
  '→': '->', '⟶': '->', '⇒': '=>', '←': '<-', '⟵': '<-', '↔': '<->', '➜': '->', '▶': '>', '◀': '<',
  '≈': '~', '≥': '>=', '≤': '<=', '≠': '!=', '±': '+/-', '−': '-', '–': '-', '—': '-',
  '•': '-', '·': '-', '‣': '-', '◦': '-', '∙': '-',
  '…': '...', '™': '(TM)', '®': '(R)', '©': '(C)',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '‚': "'", '′': "'", '″': '"',
  ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '﻿': '',
}

// WinAnsi (CP1252) extras above Latin-1 that ARE encodable — keep them.
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

function isWinAnsi(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return true
  if (cp >= 0x20 && cp <= 0x7e) return true
  if (cp >= 0xa0 && cp <= 0xff) return true
  return WINANSI_EXTRA.has(cp)
}

/** Map known symbols to ASCII, then strip any remaining non-WinAnsi char so
 * drawText never throws. Newlines and tabs survive; callers wrap/split them. */
export function sanitizeWinAnsi(input: string): string {
  if (!input) return ''
  let out = ''
  for (const ch of input) {
    const mapped = SYMBOL_MAP[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (isWinAnsi(cp)) out += ch
    // else: drop silently
  }
  return out
}

// ---------- HTML -> blocks ----------

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'para'; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '-', '&ndash;': '-', '&ldquo;': '"', '&rdquo;': '"',
  '&lsquo;': "'", '&rsquo;': "'", '&hellip;': '...', '&times;': 'x', '&pound;': '£',
  '&euro;': '€', '&deg;': 'deg', '&middot;': '-', '&bull;': '-', '&trade;': '(TM)',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|ldquo|rdquo|lsquo|rsquo|hellip|times|pound|euro|deg|middot|bull|trade);/g, m => HTML_ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
}

/** Strip all tags from a fragment and normalise whitespace to a single line. */
function textOf(fragment: string): string {
  const noTags = fragment
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim()
}

function parseTable(tableHtml: string): { head: string[]; rows: string[][] } {
  const head: string[] = []
  const rows: string[][] = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let tr: RegExpExecArray | null
  while ((tr = trRe.exec(tableHtml))) {
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
    const cells: string[] = []
    let isHead = false
    let cell: RegExpExecArray | null
    while ((cell = cellRe.exec(tr[1]))) {
      if (cell[1].toLowerCase() === 'th') isHead = true
      cells.push(textOf(cell[2]))
    }
    if (!cells.length) continue
    if (isHead && !head.length) head.push(...cells)
    else rows.push(cells)
  }
  return { head, rows }
}

/** Turn the newspaper HTML into an ordered list of headings, paragraphs and
 * tables. Crude on purpose — good enough to reconstruct a readable page. */
export function htmlToBlocks(html: string): Block[] {
  const body = (html || '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '') // charts can't be redrawn here — drop them
    .replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, '') // orphaned chart captions

  const blocks: Block[] = []
  const blockRe = /<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>|<p[^>]*>([\s\S]*?)<\/p>|<table[^>]*>([\s\S]*?)<\/table>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(body))) {
    if (m[1]) {
      const text = textOf(m[2])
      if (text) blocks.push({ type: 'heading', level: Number(m[1][1]) as 1 | 2 | 3, text })
    } else if (m[3] !== undefined) {
      const text = textOf(m[3])
      if (text) blocks.push({ type: 'para', text })
    } else if (m[4] !== undefined) {
      const { head, rows } = parseTable(m[4])
      if (head.length || rows.length) blocks.push({ type: 'table', head, rows })
    }
  }
  return blocks
}

// ---------- typesetting ----------

const A4 = { w: 595.28, h: 841.89 }
const MARGIN = { top: 54, bottom: 54, left: 50, right: 50 }
const CONTENT_W = A4.w - MARGIN.left - MARGIN.right

interface Fonts {
  serif: PDFFont
  serifBold: PDFFont
  serifItalic: PDFFont
  sans: PDFFont
  sansBold: PDFFont
  mono: PDFFont
  monoBold: PDFFont
}

const INK = rgb(0.098, 0.09, 0.075)
const GREY = rgb(0.42, 0.38, 0.34)
// the paper's up/down palette, matched to the HTML (#0c7a55 / #b03040) so the
// print edition reads as the same publication, not a monochrome fax.
const GREEN = rgb(0.047, 0.478, 0.333)
const RED = rgb(0.69, 0.188, 0.25)
const AMBER = rgb(0.541, 0.396, 0.063) // the STRONG star — #8a6510
const HAIR = rgb(0.847, 0.824, 0.769) // thin inner rules — #d8d2c4
const FAINT = rgb(0.902, 0.878, 0.824) // cell borders / level strips — #e6e0d2

const REGIME: Record<string, Color> = { green: GREEN, amber: AMBER, red: RED }
const PLAYBOOK: Record<string, string> = { R: 'Reversal', B: 'Breakout', A: 'Accumulate', S: 'Short' }

// numbers arrive as numbers (board) or already-formatted strings (ideas) — never
// print a raw 6-decimal float; the em-dot placeholder survives sanitising as '-'.
const fmtNum = (n: unknown): string =>
  typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n == null ? '·' : String(n)

/** Greedy word-wrap to a pixel width. Over-long single words are hard-split so
 * a URL or ticker blob can never overflow the margin. */
function wrapText(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean)
    if (!words.length) continue
    let line = ''
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(trial, size) <= maxW || !line) {
        // still too wide even alone -> hard-split the word
        if (!line && font.widthOfTextAtSize(word, size) > maxW) {
          let chunk = ''
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxW && chunk) {
              lines.push(chunk)
              chunk = ch
            } else chunk += ch
          }
          line = chunk
        } else line = trial
      } else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

class Cursor {
  page: PDFPage
  y: number
  pageNo = 1
  constructor(private doc: PDFDocument, private fonts: Fonts) {
    this.page = doc.addPage([A4.w, A4.h])
    this.y = A4.h - MARGIN.top
    this.footer()
  }
  private footer() {
    const label = `The Street Signal  ·  page ${this.pageNo}`
    const size = 8
    const w = this.fonts.sans.widthOfTextAtSize(label, size)
    this.page.drawText(label, { x: (A4.w - w) / 2, y: MARGIN.bottom - 22, size, font: this.fonts.sans, color: GREY })
  }
  need(height: number) {
    if (this.y - height < MARGIN.bottom) {
      this.page = this.doc.addPage([A4.w, A4.h])
      this.y = A4.h - MARGIN.top
      this.pageNo += 1
      this.footer()
    }
  }
  gap(h: number) {
    this.y -= h
  }
  line(text: string, font: PDFFont, size: number, color = INK, x = MARGIN.left, lineH = size * 1.35) {
    this.need(lineH)
    this.y -= lineH
    this.page.drawText(text, { x, y: this.y, size, font, color })
  }
  rule(color = INK, thickness = 1) {
    this.need(6)
    this.y -= 4
    this.page.drawLine({ start: { x: MARGIN.left, y: this.y }, end: { x: A4.w - MARGIN.right, y: this.y }, thickness, color })
  }
}

function drawParagraph(c: Cursor, text: string, fonts: Fonts) {
  const size = 10.5
  for (const line of wrapText(sanitizeWinAnsi(text), fonts.serif, size, CONTENT_W)) {
    c.line(line, fonts.serif, size, INK, MARGIN.left, size * 1.4)
  }
  c.gap(4)
}

function drawHeading(c: Cursor, level: 1 | 2 | 3, text: string, fonts: Fonts) {
  const clean = sanitizeWinAnsi(text)
  if (level === 1) {
    c.gap(6)
    for (const line of wrapText(clean, fonts.serifBold, 20, CONTENT_W)) c.line(line, fonts.serifBold, 20, INK, MARGIN.left, 24)
    c.gap(4)
    return
  }
  if (level === 2) {
    c.gap(10)
    c.need(30)
    c.rule(INK, 1.4)
    for (const line of wrapText(clean.toUpperCase(), fonts.sans, 10, CONTENT_W)) c.line(line, fonts.sans, 10, GREY, MARGIN.left, 15)
    c.gap(3)
    return
  }
  c.gap(6)
  for (const line of wrapText(clean, fonts.serifBold, 12, CONTENT_W)) c.line(line, fonts.serifBold, 12, INK, MARGIN.left, 15)
  c.gap(2)
}

function drawTable(c: Cursor, head: string[], rows: string[][], fonts: Fonts) {
  const ncols = Math.max(head.length, ...rows.map(r => r.length), 1)
  const norm = (r: string[]) => Array.from({ length: ncols }, (_, i) => sanitizeWinAnsi(r[i] ?? ''))
  const H = head.length ? norm(head) : []
  const R = rows.slice(0, 40).map(norm)

  // column char-widths from content, capped so one prose column can't run away
  const MAX_COL = 46
  const colChars = Array.from({ length: ncols }, (_, i) =>
    Math.min(MAX_COL, Math.max(H[i]?.length ?? 0, ...R.map(r => r[i].length), 1)),
  )
  const GUTTER = 2
  const size = 8
  const charW = fonts.mono.widthOfTextAtSize('M', size) // Courier is monospaced
  let totalChars = colChars.reduce((a, b) => a + b, 0) + GUTTER * (ncols - 1)
  // shrink the widest columns until the row fits the page
  while (totalChars * charW > CONTENT_W) {
    const widest = colChars.indexOf(Math.max(...colChars))
    if (colChars[widest] <= 6) break
    colChars[widest] -= 1
    totalChars -= 1
  }

  const cell = (s: string, i: number) => {
    const w = colChars[i]
    const t = s.length > w ? (w > 1 ? s.slice(0, w - 1) + '~' : s.slice(0, w)) : s
    return t.padEnd(w, ' ')
  }
  const rowStr = (r: string[]) => r.map((s, i) => cell(s, i)).join(' '.repeat(GUTTER))
  const lineH = size * 1.5

  c.gap(4)
  if (H.length) {
    c.line(rowStr(H), fonts.monoBold, size, INK, MARGIN.left, lineH)
    c.line('-'.repeat(Math.min(totalChars, Math.floor(CONTENT_W / charW))), fonts.mono, size, GREY, MARGIN.left, size)
  }
  for (const r of R) c.line(rowStr(r), fonts.mono, size, INK, MARGIN.left, lineH)
  c.gap(6)
}

// ---------- data-path drawing primitives ----------
// pdf-lib gives us rectangles, lines and coloured text — enough to draw the
// paper's rich furniture. Borders are always four drawLine calls (drawRectangle's
// default-fill behaviour is version-touchy); fills go through drawRectangle so we
// get real alpha tints for the heat cells.

function box(page: PDFPage, x: number, y: number, w: number, h: number, o: { fill?: Color; fillOpacity?: number; border?: Color; borderWidth?: number }): void {
  if (o.fill) page.drawRectangle({ x, y, width: w, height: h, color: o.fill, opacity: o.fillOpacity ?? 1, borderWidth: 0 })
  if (o.border) {
    const t = o.borderWidth ?? 1
    page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: t, color: o.border })
    page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y: y + h }, thickness: t, color: o.border })
    page.drawLine({ start: { x, y }, end: { x, y: y + h }, thickness: t, color: o.border })
    page.drawLine({ start: { x: x + w, y }, end: { x: x + w, y: y + h }, thickness: t, color: o.border })
  }
}

/** Hard-clip a string to a pixel width — no ellipsis (its width is unpredictable
 * once sanitised); a truncated company name is better than an overflowed margin. */
function clip(text: string, font: PDFFont, size: number, maxW: number): string {
  if (maxW <= 0) return ''
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let s = text
  while (s.length > 1 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1)
  return s
}

// an inline run of typeset furniture: a coloured text span or a bordered chip.
type Seg = { kind: 'text' | 'chip'; text: string; font: PDFFont; size: number; color: Color; border?: Color }

/** Lay segments left-to-right on one line, advancing x; optionally park a small
 * run hard against the right margin (the board's probability). Short headers
 * only — over-long spans clip rather than wrap. */
function drawSegments(c: Cursor, segs: Seg[], lineH: number, opts?: { x0?: number; right?: { text: string; font: PDFFont; size: number; color: Color }[] }): void {
  c.need(lineH)
  c.y -= lineH
  const baseY = c.y
  const maxX = A4.w - MARGIN.right
  let x = opts?.x0 ?? MARGIN.left
  for (const s of segs) {
    const t = sanitizeWinAnsi(s.text)
    if (!t) continue
    if (s.kind === 'chip') {
      const w = s.font.widthOfTextAtSize(t, s.size)
      const boxW = w + 8
      if (x + boxW > maxX) continue
      box(c.page, x, baseY - 2, boxW, s.size + 4, { border: s.border ?? HAIR, borderWidth: 0.6 })
      c.page.drawText(t, { x: x + 4, y: baseY, size: s.size, font: s.font, color: s.color })
      x += boxW + 6
    } else {
      const w = s.font.widthOfTextAtSize(t, s.size)
      if (x + w > maxX) {
        const cl = clip(t, s.font, s.size, maxX - x)
        if (cl) c.page.drawText(cl, { x, y: baseY, size: s.size, font: s.font, color: s.color })
        break
      }
      c.page.drawText(t, { x, y: baseY, size: s.size, font: s.font, color: s.color })
      x += w + 6
    }
  }
  if (opts?.right?.length) {
    const total = opts.right.reduce((sum, r) => sum + r.font.widthOfTextAtSize(sanitizeWinAnsi(r.text), r.size), 0)
    let rx = maxX - total
    for (const r of opts.right) {
      const t = sanitizeWinAnsi(r.text)
      c.page.drawText(t, { x: rx, y: baseY, size: r.size, font: r.font, color: r.color })
      rx += r.font.widthOfTextAtSize(t, r.size)
    }
  }
}

/** The four-cell entry/invalidation/target/potential strip under each idea —
 * hairline box with vertical dividers, small-caps label over a bold numeral. */
function drawLevels(c: Cursor, cells: [string, string][], fonts: Fonts, x0: number, w: number): void {
  const H = 36
  c.need(H)
  c.y -= H
  const bottom = c.y
  const top = c.y + H
  const cellW = w / cells.length
  box(c.page, x0, bottom, w, H, { fill: INK, fillOpacity: 0.03, border: FAINT, borderWidth: 0.6 })
  for (let i = 0; i < cells.length; i++) {
    const cx = x0 + i * cellW
    if (i > 0) c.page.drawLine({ start: { x: cx, y: bottom + 3 }, end: { x: cx, y: top - 3 }, thickness: 0.6, color: FAINT })
    c.page.drawText(sanitizeWinAnsi(cells[i][0].toUpperCase()), { x: cx + 8, y: top - 12, size: 7, font: fonts.sansBold, color: GREY })
    // numeric levels sit at 11; a long qualitative "potential" phrase shrinks to
    // fit rather than getting sliced mid-word — clip is the last resort at the floor
    const raw = sanitizeWinAnsi(String(cells[i][1] ?? '·'))
    let vSize = 11
    while (vSize > 8 && fonts.sansBold.widthOfTextAtSize(raw, vSize) > cellW - 14) vSize -= 0.5
    const val = clip(raw, fonts.sansBold, vSize, cellW - 14)
    c.page.drawText(val, { x: cx + 8, y: bottom + 9, size: vSize, font: fonts.sansBold, color: INK })
  }
}

/** Section rubric: the paper's uppercase, rule-topped department header. */
function sectionHeader(c: Cursor, title: string, fonts: Fonts): void {
  c.gap(12)
  c.need(26)
  c.rule(INK, 1.4)
  c.gap(3)
  c.line(sanitizeWinAnsi(title.toUpperCase()), fonts.sans, 9.5, GREY, MARGIN.left, 13)
  c.gap(4)
}

/** Paragraph prose split on blank lines — Times, the paper's body face. */
function drawProse(c: Cursor, text: unknown, fonts: Fonts, x0 = MARGIN.left, w = CONTENT_W, size = 10.5): void {
  for (const para of String(text ?? '').split(/\n\n+/)) {
    const t = para.trim()
    if (!t) continue
    for (const line of wrapText(sanitizeWinAnsi(t), fonts.serif, size, w)) c.line(line, fonts.serif, size, INK, x0, size * 1.4)
    c.gap(5)
  }
}

function drawFootline(c: Cursor, text: string, fonts: Fonts): void {
  for (const l of wrapText(sanitizeWinAnsi(text), fonts.serifItalic, 8.5, CONTENT_W)) c.line(l, fonts.serifItalic, 8.5, GREY, MARGIN.left, 11)
}

// ---------- The Signal ----------

function drawSignal(c: Cursor, signal: ComposedReport['signal'], signalWhy: string | undefined, fonts: Fonts): void {
  if (!signal && !signalWhy) return
  sectionHeader(c, "The Signal — Today's Conviction Call", fonts)
  const padX = 14
  const padY = 12
  const innerX = MARGIN.left + padX
  const innerW = CONTENT_W - padX * 2

  if (!signal) {
    const lines = wrapText(sanitizeWinAnsi(`No conviction call today — ${signalWhy}`), fonts.serifItalic, 12, innerW)
    const total = padY * 2 + lines.length * 16
    c.need(total + 4)
    const top = c.y
    const bottom = c.y - total
    box(c.page, MARGIN.left, bottom, CONTENT_W, total, { fill: INK, fillOpacity: 0.03, border: INK, borderWidth: 1 })
    let yy = top - padY - 12
    for (const l of lines) {
      c.page.drawText(l, { x: innerX, y: yy, size: 12, font: fonts.serifItalic, color: GREY })
      yy -= 16
    }
    c.y = bottom
    c.gap(6)
    return
  }

  const ev = signal.evidence ?? { data: '', news: '', channels: '', social: '', company: '' }
  const evRows: [string, string][] = ([['Chart', ev.data], ['News', ev.news], ['Channels', ev.channels], ['Social', ev.social], ['Company', ev.company]] as [string, string | undefined][])
    .filter((r): r is [string, string] => !!r[1])
    .map(r => [r[0], String(r[1])])
  const labelW = 66
  const thesisLines = wrapText(sanitizeWinAnsi(signal.thesis ?? ''), fonts.serif, 12, innerW)
  const evWrapped = evRows.map(([lab, v]) => ({ lab, lines: wrapText(sanitizeWinAnsi(v), fonts.serif, 9.5, innerW - labelW) }))
  const actionLines = signal.action ? wrapText(sanitizeWinAnsi(signal.action), fonts.serif, 10.5, innerW) : []

  const headerH = 24
  const thesisH = thesisLines.length * 15 + 8
  const evH = evWrapped.reduce((s, r) => s + Math.max(1, r.lines.length) * 12 + 3, 0) + 4
  const actionH = actionLines.length ? 13 + actionLines.length * 14 + 4 : 0
  const total = padY * 2 + headerH + thesisH + evH + actionH
  c.need(total + 4)
  const top = c.y
  const bottom = c.y - total
  box(c.page, MARGIN.left, bottom, CONTENT_W, total, { fill: GREEN, fillOpacity: 0.06, border: INK, borderWidth: 1.5 })

  let yy = top - padY
  // header: big ticker, company, move+grade parked right
  const tk = sanitizeWinAnsi(signal.ticker ?? '')
  c.page.drawText(tk, { x: innerX, y: yy - 16, size: 20, font: fonts.serifBold, color: INK })
  const tkW = fonts.serifBold.widthOfTextAtSize(tk, 20)
  const moveTxt = sanitizeWinAnsi(`${signal.expectedMove ?? ''}  Grade ${signal.conviction ?? ''}`.trim())
  const moveW = fonts.sansBold.widthOfTextAtSize(moveTxt, 10)
  const comp = clip(sanitizeWinAnsi(signal.company ?? ''), fonts.serif, 12, innerW - tkW - moveW - 24)
  if (comp) c.page.drawText(comp, { x: innerX + tkW + 8, y: yy - 14, size: 12, font: fonts.serif, color: GREY })
  c.page.drawText(moveTxt, { x: A4.w - MARGIN.right - padX - moveW, y: yy - 14, size: 10, font: fonts.sansBold, color: GREEN })
  yy -= headerH

  for (const l of thesisLines) {
    c.page.drawText(l, { x: innerX, y: yy - 11, size: 12, font: fonts.serif, color: INK })
    yy -= 15
  }
  yy -= 8

  for (const r of evWrapped) {
    c.page.drawText(sanitizeWinAnsi(r.lab.toUpperCase()), { x: innerX, y: yy - 9, size: 8, font: fonts.sansBold, color: GREY })
    const ls = r.lines.length ? r.lines : ['']
    for (let i = 0; i < ls.length; i++) c.page.drawText(ls[i], { x: innerX + labelW, y: yy - 9 - i * 12, size: 9.5, font: fonts.serif, color: INK })
    yy -= Math.max(1, r.lines.length) * 12 + 3
  }
  yy -= 4

  if (actionLines.length) {
    c.page.drawText('ACTION', { x: innerX, y: yy - 9, size: 8, font: fonts.sansBold, color: GREY })
    yy -= 13
    for (const l of actionLines) {
      c.page.drawText(l, { x: innerX, y: yy - 10, size: 10.5, font: fonts.serif, color: INK })
      yy -= 14
    }
  }
  c.y = bottom
  c.gap(8)
}

// ---------- Markets at a Glance: SPY sparkline + sector heat map ----------

function drawSpyChart(c: Cursor, closes: number[], fonts: Fonts): void {
  const pts = (closes ?? []).filter(n => typeof n === 'number' && isFinite(n))
  if (pts.length < 2) return
  const chartW = Math.min(320, CONTENT_W)
  const chartH = 58
  const H = chartH + 24
  c.need(H)
  c.y -= H
  const bottom = c.y + 16
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const up = pts[pts.length - 1] >= pts[0]
  const col = up ? GREEN : RED
  box(c.page, MARGIN.left, bottom, chartW, chartH, { border: HAIR, borderWidth: 0.8 })
  const px = (i: number) => MARGIN.left + 5 + (i / (pts.length - 1)) * (chartW - 10)
  const py = (v: number) => bottom + 5 + ((v - min) / span) * (chartH - 10)
  for (let i = 1; i < pts.length; i++) c.page.drawLine({ start: { x: px(i - 1), y: py(pts[i - 1]) }, end: { x: px(i), y: py(pts[i]) }, thickness: 1.2, color: col })
  const chg = pts[0] ? ((pts[pts.length - 1] - pts[0]) / pts[0]) * 100 : 0
  const cap = sanitizeWinAnsi(`S&P 500 — three months`)
  c.page.drawText(cap, { x: MARGIN.left, y: c.y + 4, size: 8.5, font: fonts.sans, color: GREY })
  const chgTxt = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`
  c.page.drawText(chgTxt, { x: MARGIN.left + fonts.sans.widthOfTextAtSize(cap, 8.5) + 8, y: c.y + 4, size: 8.5, font: fonts.sansBold, color: col })
}

function drawHeatMap(c: Cursor, bars: NonNullable<PaperExtras['sectorBars']>, fonts: Fonts): void {
  const rows = bars.filter(b => b && b.rs21 != null) as { name: string; rs21: number }[]
  if (!rows.length) return
  c.gap(6)
  c.line(sanitizeWinAnsi('Sector strength vs S&P 500 — one month (pp)'), fonts.sans, 8, GREY, MARGIN.left, 11)
  c.gap(3)
  const maxAbs = Math.max(...rows.map(b => Math.abs(b.rs21)), 1)
  const perRow = rows.length > 6 ? Math.ceil(rows.length / 2) : rows.length
  const cellW = CONTENT_W / perRow
  const cellH = 34
  const nRows = Math.ceil(rows.length / perRow)
  for (let r = 0; r < nRows; r++) {
    c.need(cellH + 3)
    c.y -= cellH
    const bottom = c.y
    const top = c.y + cellH
    for (let i = 0; i < perRow; i++) {
      const b = rows[r * perRow + i]
      if (!b) continue
      const cx = MARGIN.left + i * cellW
      const alpha = 0.1 + (Math.abs(b.rs21) / maxAbs) * 0.4
      const col = b.rs21 >= 0 ? GREEN : RED
      box(c.page, cx, bottom, cellW, cellH, { fill: col, fillOpacity: alpha, border: FAINT, borderWidth: 0.5 })
      const name = clip(sanitizeWinAnsi(b.name || ''), fonts.sans, 8, cellW - 8)
      c.page.drawText(name, { x: cx + (cellW - fonts.sans.widthOfTextAtSize(name, 8)) / 2, y: top - 12, size: 8, font: fonts.sans, color: INK })
      const val = `${b.rs21 >= 0 ? '+' : ''}${b.rs21}`
      c.page.drawText(val, { x: cx + (cellW - fonts.sansBold.widthOfTextAtSize(val, 11)) / 2, y: bottom + 8, size: 11, font: fonts.sansBold, color: col })
    }
    c.gap(3)
  }
}

// ---------- The Board ----------

export type PrintBoardRow = NonNullable<PaperExtras['engineBoard']>[number]

/** What the print edition says ABOUT one board row — the same three decisions
 * the emailed paper makes in newspaper.ts, kept pure and exported so the rule is
 * testable without decompressing a PDF content stream.
 *
 * A near miss cleared NO gate: the engine looked and said no, and the row is
 * printed only so a side with nothing on it is not blank. Its grade C and its
 * probability are placeholders it never earned — a letter and a percentage
 * printed beside it would be fictions dressed as measurements — so it gets
 * neither, and says what it is instead. Its levels stay as orientation.
 *
 * An observation is the mirror image: it cleared EVERY gate, so its grade and its
 * probability are real and both print. What it has no route to is the market — an
 * ISA cannot place it — so it says that where a placeable row prints its ETP, and
 * its chip reads 'observation' rather than 'watch' (the footer explains watch rows
 * as thin evidence, which this row is the opposite of).
 *
 * A WILDCARD SAYS SO IN WORDS, and leads with it. The print edition is the one
 * surface that cannot show the mark: 🃏 is U+1F0CF and the WinAnsi standard fonts
 * have no code point for it, so `sanitizeWinAnsi` drops it — silently, which is
 * the worst of both outcomes on a row whose whole point is that it is not an
 * ordinary call. The word carries it here, ahead of a letter that is a stored
 * `grade ?? 'C'` rather than a verdict; the footer says what the word means. */
export function boardPrintRow(b: PrintBoardRow): { chip: string; route: string; probability: string | null } {
  if (b.nearMiss) return { chip: 'nearest miss — did not clear the gates', route: 'no size', probability: null }
  const mark = b.wildcard ? 'wildcard ' : ''
  if (b.observation)
    return {
      chip: `${mark}${b.grade}${b.provisional ? ' prov' : ''} observation`,
      route: 'no ISA route - observation only',
      probability: `${Math.round((b.probability || 0) * 100)}%`,
    }
  return {
    chip: `${mark}${b.grade}${b.provisional ? ' prov' : ''}${b.watchOnly ? ' watch' : ''}`,
    route: b.watchOnly ? 'watch - no size' : b.instrument ? `${b.instrument.ticker} ${b.instrument.leverage}x` : b.paperOnly ? 'paper-only' : 'cash',
    probability: `${Math.round((b.probability || 0) * 100)}%`,
  }
}

/** The footer, taken from the paper's own boardFootnote so print and email can
 * never explain the board differently — it already names only the row kinds
 * actually present. HTML entities are the only thing that does not survive the
 * trip into a PDF text run, so they are decoded here (and the em dashes then
 * fold to ASCII in sanitizeWinAnsi like every other glyph).
 *
 * …and the wildcard MARK is dropped HERE rather than left to vanish at draw time:
 * U+1F0CF has no WinAnsi code point, so `sanitizeWinAnsi` would strip the glyph
 * and leave its trailing space stranded mid-sentence. The clause is written to
 * read true without it — "Wildcard rows are experiments, not calls: …" — so this
 * is a removal, not a fallback. */
export function boardPrintFootline(board: readonly PrintBoardRow[]): string {
  return boardFootnote(board)
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(`${WILDCARD_MARK} `, '')
}

function drawBoard(c: Cursor, board: NonNullable<PaperExtras['engineBoard']>, fonts: Fonts): void {
  for (const b of board) {
    if (!b || !b.sym) continue
    const isShort = b.side === 'short'
    const sideCol = isShort ? RED : GREEN
    const { chip, route, probability } = boardPrintRow(b)
    const segs: Seg[] = [{ kind: 'text', text: b.sym, font: fonts.sansBold, size: 11, color: INK }]
    if (reportStockName(b.sym, b.name)) segs.push({ kind: 'text', text: `- ${reportStockName(b.sym, b.name)}`, font: fonts.sans, size: 9.5, color: GREY })
    segs.push({ kind: 'text', text: isShort ? 'SHORT' : 'LONG', font: fonts.sansBold, size: 9, color: sideCol })
    segs.push({ kind: 'chip', text: chip, font: fonts.sans, size: 7.5, color: GREY, border: HAIR })
    drawSegments(c, segs, 15, { right: probability ? [{ text: probability, font: fonts.sansBold, size: 10, color: INK }] : [] })
    const l2 = `in ${fmtNum(b.entry)}  ·  stop ${fmtNum(b.stop)}  ·  tgt ${fmtNum(b.target)}  ·  ~${b.expectedMovePct}%  ·  ${route}${b.earningsRisk ? '  ·  earnings' : ''}`
    c.line(sanitizeWinAnsi(l2), fonts.sans, 9, GREY, MARGIN.left, 13)
    c.gap(4)
    c.rule(FAINT, 0.5)
  }
  c.gap(3)
  drawFootline(c, boardPrintFootline(board), fonts)
}

// ---------- ruled data tables (calendar / social / IPO / rotation) ----------

interface GCol { header: string; w: number; align?: 'r' }
type GCell = { text: string; color?: Color; align?: 'r'; bold?: boolean }

/** A real broadsheet table: uppercase header with an ink rule, per-cell wrapping
 * (so a long event title grows its row instead of overflowing), hairline row
 * rules, Helvetica numerals, up/down colour where the cell asks for it. */
function drawGridTable(c: Cursor, cols: GCol[], rows: GCell[][], fonts: Fonts): void {
  const pad = 5
  const hSize = 8
  const cSize = 9
  const lineH = 12.5
  c.need(20)
  c.y -= 14
  const hy = c.y
  let x = MARGIN.left
  for (const col of cols) {
    const t = sanitizeWinAnsi(col.header.toUpperCase())
    const tw = fonts.sansBold.widthOfTextAtSize(t, hSize)
    c.page.drawText(t, { x: col.align === 'r' ? x + col.w - pad - tw : x + pad, y: hy, size: hSize, font: fonts.sansBold, color: GREY })
    x += col.w
  }
  c.y -= 4
  c.page.drawLine({ start: { x: MARGIN.left, y: c.y }, end: { x: A4.w - MARGIN.right, y: c.y }, thickness: 0.8, color: INK })
  for (const row of rows) {
    const cellLines = row.map((cell, i) => wrapText(sanitizeWinAnsi(cell.text), cell.bold ? fonts.sansBold : fonts.sans, cSize, cols[i].w - pad * 2))
    const n = Math.max(1, ...cellLines.map(l => l.length))
    const rowH = n * lineH + 5
    c.need(rowH)
    const startY = c.y
    let cx = MARGIN.left
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]
      const cell = row[i]
      const font = cell.bold ? fonts.sansBold : fonts.sans
      const lines = cellLines[i].length ? cellLines[i] : ['']
      for (let li = 0; li < lines.length; li++) {
        const t = lines[li]
        const tw = font.widthOfTextAtSize(t, cSize)
        c.page.drawText(t, { x: cell.align === 'r' || col.align === 'r' ? cx + col.w - pad - tw : cx + pad, y: startY - 10 - li * lineH, size: cSize, font, color: cell.color ?? INK })
      }
      cx += col.w
    }
    c.y = startY - rowH
    c.page.drawLine({ start: { x: MARGIN.left, y: c.y + 1 }, end: { x: A4.w - MARGIN.right, y: c.y + 1 }, thickness: 0.5, color: FAINT })
  }
  c.gap(6)
}

function drawCalendar(c: Cursor, calendar: CalendarRow[], fonts: Fonts): void {
  const cols: GCol[] = [
    { header: 'Event', w: CONTENT_W * 0.54 },
    { header: 'When (UK)', w: CONTENT_W * 0.24, align: 'r' },
    { header: 'Fcst / Prev', w: CONTENT_W * 0.22, align: 'r' },
  ]
  const rows: GCell[][] = calendar.slice(0, 8).map(e => {
    const when = new Date((e.at || 0) * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
    const tag = e.impact ? ` [${e.impact}]` : ''
    return [
      { text: `${e.title || ''}${tag}  ${e.country || ''}`.trim(), color: e.impact === 'High' ? RED : INK },
      { text: when, align: 'r' },
      { text: `${e.forecast ?? '·'} / ${e.previous ?? '·'}`, align: 'r' },
    ]
  })
  drawGridTable(c, cols, rows, fonts)
}

function drawWeekAhead(c: Cursor, days: NonNullable<PaperExtras['weekAhead']>, fonts: Fonts): void {
  const cols: GCol[] = [
    { header: 'Day', w: CONTENT_W * 0.2 },
    { header: 'Data & events (UK)', w: CONTENT_W * 0.46 },
    { header: 'Reporting', w: CONTENT_W * 0.34 },
  ]
  const rows: GCell[][] = days.map(d => [
    { text: d.label || d.date, bold: true },
    {
      text:
        (d.events ?? [])
          .map(e => {
            const at = new Date((e.at || 0) * 1000).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' })
            return `${at} ${e.title || ''} [${e.impact || ''}] ${e.country || ''}`.trim()
          })
          .join('; ') || (d.eventsKnown === false ? 'Calendar not yet published' : 'No major US/UK data'),
    },
    { text: (d.earnings ?? []).map(r => `${r.sym} (${earningsTimeWords(r.time)})`).join('; ') || (d.earningsKnown === false ? 'Earnings calendar unavailable' : 'No major earnings') },
  ])
  drawGridTable(c, cols, rows, fonts)
}

function drawSocial(c: Cursor, social: SocialRow[], fonts: Fonts): void {
  const cols: GCol[] = [
    { header: 'Company', w: CONTENT_W * 0.40 },
    { header: 'Mkt cap', w: CONTENT_W * 0.12, align: 'r' },
    { header: 'r/ rank', w: CONTENT_W * 0.10, align: 'r' },
    { header: 'Mentions', w: CONTENT_W * 0.12, align: 'r' },
    { header: '24h surge', w: CONTENT_W * 0.13, align: 'r' },
    { header: 'Platforms', w: CONTENT_W * 0.13, align: 'r' },
  ]
  const rows: GCell[][] = social
    .slice(0, 10)
    // same door as the emailed edition: an unbelievable cap is an unknown cap
    .map(s => ({ ...s, capUsdM: plausibleCapUsdM(s.capUsdM, s.sym) }))
    .map(s => [
    { text: reportStockLabel(s.sym || ''), bold: true },
    { text: s.capUsdM == null ? '·' : s.capUsdM >= 1000 ? `$${(s.capUsdM / 1000).toFixed(1)}B` : `$${Math.round(s.capUsdM)}M`, align: 'r' },
    { text: s.redditRank == null ? '·' : `#${s.redditRank}`, align: 'r' },
    { text: s.redditMentions == null ? '·' : String(s.redditMentions), align: 'r' },
    { text: s.surgeMultiple == null ? '·' : `${s.surgeMultiple}x`, align: 'r', color: s.surgeMultiple != null && s.surgeMultiple >= 2 ? GREEN : INK },
    { text: String(s.sources ?? '·'), align: 'r' },
    ])
  drawGridTable(c, cols, rows, fonts)
}

function drawIpos(c: Cursor, ipos: NonNullable<PaperExtras['ipos']>, fonts: Fonts): void {
  const list = [
    ...(ipos.upcoming ?? []).map(r => ({ r, when: 'Upcoming' })),
    ...(ipos.recent ?? []).map(r => ({ r, when: 'Listed' })),
  ].slice(0, 8)
  if (!list.length) return
  const cols: GCol[] = [
    { header: 'Ticker', w: CONTENT_W * 0.16 },
    { header: 'Company', w: CONTENT_W * 0.40 },
    { header: 'Date', w: CONTENT_W * 0.18, align: 'r' },
    { header: 'Status', w: CONTENT_W * 0.26, align: 'r' },
  ]
  const rows: GCell[][] = list.map(({ r, when }) => [
    { text: r.sym || '', bold: true },
    { text: r.name || '' },
    { text: r.date || '', align: 'r' },
    { text: `${when} · ${r.status || ''}`, align: 'r' },
  ])
  drawGridTable(c, cols, rows, fonts)
}

function drawEventRadar(c: Cursor, radar: NonNullable<ReportPrintData['eventRadar']>, fonts: Fonts): void {
  // ticker + company merged into one wide Company cell (no fixed width) so a long
  // name grows the column rather than crushing it — the New Listings pattern.
  const cols: GCol[] = [
    { header: 'Company', w: CONTENT_W * 0.34 },
    { header: 'Prints', w: CONTENT_W * 0.2, align: 'r' },
    { header: 'The shape going in', w: CONTENT_W * 0.46 },
  ]
  const rows: GCell[][] = radar.slice(0, 12).map(e => {
    const rs = e.rs21 == null ? '' : `RS ${e.rs21 >= 0 ? '+' : ''}${e.rs21}pp`
    const shape = [e.stage ?? '', rs, e.note ?? ''].filter(Boolean).join(' - ')
    return [
      { text: `${e.sym || ''}${e.name ? `  ${e.name}` : ''}`, bold: true },
      { text: `${e.date || ''}  ${e.daysToPrint}d`, align: 'r' },
      { text: shape, color: e.rs21 != null && e.rs21 < 0 ? RED : INK },
    ]
  })
  drawGridTable(c, cols, rows, fonts)
  c.gap(2)
  drawFootline(c, "The engine never bets an earnings print - this is the shape going in, so a big overnight surprise is never a name you'd never heard of.", fonts)
}

function drawRotation(c: Cursor, tables: NonNullable<ReportPrintData['rotationTables']>, fonts: Fonts): void {
  for (const t of tables) {
    c.gap(6)
    c.line(sanitizeWinAnsi(`${t.sector} (${t.etf})`), fonts.serifBold, 11, INK, MARGIN.left, 15)
    c.gap(2)
    const cols: GCol[] = [
      { header: 'Stock', w: CONTENT_W * 0.34 },
      { header: 'Price', w: CONTENT_W * 0.33, align: 'r' },
      { header: '1 week', w: CONTENT_W * 0.33, align: 'r' },
    ]
    const rows: GCell[][] = (t.rows ?? []).map(row => [
      { text: reportStockLabel(row.sym || ''), bold: true },
      { text: row.price == null ? '·' : row.price.toLocaleString('en-US', { maximumFractionDigits: 2 }), align: 'r' },
      { text: row.wkPct == null ? '·' : `${row.wkPct >= 0 ? '+' : ''}${row.wkPct.toFixed(1)}%`, align: 'r', color: row.wkPct == null ? INK : row.wkPct >= 0 ? GREEN : RED },
    ])
    drawGridTable(c, cols, rows, fonts)
  }
}

// ---------- Today's Ideas ----------

function drawIdea(c: Cursor, idea: Idea, fonts: Fonts): void {
  const strong = idea.strength === 'strong'
  const pad = strong ? 10 : 0
  const x0 = MARGIN.left + pad
  const w = CONTENT_W - pad * 2
  const isShort = idea.side === 'short'
  const sideCol = isShort ? RED : GREEN

  const caseLines = wrapText(sanitizeWinAnsi(idea.caseText ?? ''), fonts.serif, 10.5, w)
  // …with the model's own numbering stripped, exactly as the emailed edition
  // does it: the template owns the numbers, and both used to print "1) 1. …"
  const reasonsText = idea.reasons?.length ? `${strong ? 'I STRONGLY SUGGEST — ' : 'Why: '}${idea.reasons.map((t, n) => `${n + 1}) ${stripLeadingNumber(t)}`).join('   ')}` : ''
  const reasonLines = reasonsText ? wrapText(sanitizeWinAnsi(reasonsText), fonts.serif, 9.5, w) : []
  const annotParts: string[] = []
  if (idea.chartRead) annotParts.push(`Chart: ${idea.chartRead}`)
  if (idea.streetCheck) annotParts.push(`Street: ${idea.streetCheck}`)
  const annotLines = annotParts.length ? wrapText(sanitizeWinAnsi(annotParts.join('   -   ')), fonts.serifItalic, 9, w) : []

  // exact height so the STRONG tint wraps the block precisely — see the running
  // sum in the draw calls below; every constant here matches one there.
  const H_case = 14 * caseLines.length
  const H_reasons = reasonLines.length ? 5 + 13 * reasonLines.length : 0
  const H_annot = annotLines.length ? 5 + 12 * annotLines.length : 0
  const total = 86 + H_case + H_reasons + H_annot
  c.need(total)
  const top = c.y
  if (strong) box(c.page, MARGIN.left, top - total, CONTENT_W, total, { fill: GREEN, fillOpacity: 0.05 })

  c.gap(6)
  const segs: Seg[] = [{ kind: 'text', text: idea.ticker || '', font: fonts.serifBold, size: 15, color: INK }]
  if (reportStockName(idea.ticker, idea.name)) segs.push({ kind: 'text', text: `- ${reportStockName(idea.ticker, idea.name)}`, font: fonts.serif, size: 12, color: GREY })
  segs.push({ kind: 'text', text: isShort ? 'SHORT' : 'LONG', font: fonts.sansBold, size: 10, color: sideCol })
  segs.push({ kind: 'chip', text: PLAYBOOK[idea.playbook] ?? String(idea.playbook || ''), font: fonts.sans, size: 8, color: GREY, border: HAIR })
  segs.push({ kind: 'chip', text: `Grade ${idea.conviction || ''}`, font: fonts.sans, size: 8, color: INK, border: INK })
  if (strong) segs.push({ kind: 'text', text: 'STRONG', font: fonts.sansBold, size: 9, color: AMBER })
  drawSegments(c, segs, 20, { x0 })

  c.gap(4)
  drawLevels(c, [['Entry', idea.entry], ['Invalidation', idea.invalidation], ['Target', idea.target], ['Potential', idea.expectedMove || '·']], fonts, x0, w)
  c.gap(6)
  for (const l of caseLines) c.line(l, fonts.serif, 10.5, INK, x0, 14)
  if (reasonLines.length) {
    c.gap(5)
    for (const l of reasonLines) c.line(l, fonts.serif, 9.5, rgb(0.24, 0.22, 0.18), x0, 13)
  }
  if (annotLines.length) {
    c.gap(5)
    for (const l of annotLines) c.line(l, fonts.serifItalic, 9, GREY, x0, 12)
  }
  c.gap(10)
  c.rule(HAIR, 0.6)
}

// ---------- the print edition, typeset from structured data ----------

function drawPrintEdition(c: Cursor, fonts: Fonts, p: ReportPrintData): void {
  const R = p.report ?? {}

  if (R.headline) {
    c.gap(4)
    for (const line of wrapText(sanitizeWinAnsi(R.headline), fonts.serifBold, 21, CONTENT_W)) c.line(line, fonts.serifBold, 21, INK, MARGIN.left, 25)
    c.gap(2)
    c.line(sanitizeWinAnsi('BY THE DESK - STREET SIGNAL RESEARCH'), fonts.sans, 8, GREY, MARGIN.left, 12)
    c.gap(2)
  }
  if (R.standfirst) {
    for (const line of wrapText(sanitizeWinAnsi(R.standfirst), fonts.serifItalic, 13, CONTENT_W)) c.line(line, fonts.serifItalic, 13, GREY, MARGIN.left, 17)
    c.gap(6)
  }
  if (R.lead) drawProse(c, R.lead, fonts)

  drawSignal(c, R.signal, R.signalWhy, fonts)

  if ((p.spyCloses?.length ?? 0) >= 2 || p.sectorBars?.some(b => b && b.rs21 != null)) {
    sectionHeader(c, 'Markets at a Glance', fonts)
    if (p.spyCloses?.length) drawSpyChart(c, p.spyCloses, fonts)
    if (p.sectorBars?.length) drawHeatMap(c, p.sectorBars, fonts)
  }

  if (p.engineBoard?.length) {
    sectionHeader(c, 'The Board — Engine Calls', fonts)
    drawBoard(c, p.engineBoard, fonts)
  }

  const proseSection = (title: string, text: unknown) => {
    if (text && String(text).trim()) {
      sectionHeader(c, title, fonts)
      drawProse(c, text, fonts)
    }
  }

  if (R.weekAhead) proseSection('The Week Ahead', R.weekAhead)
  if (p.weekAhead?.length) {
    sectionHeader(c, 'The Week Ahead — Day by Day', fonts)
    drawWeekAhead(c, p.weekAhead, fonts)
  }

  proseSection('Portfolio Desk', R.portfolioDesk)
  proseSection('The Tape', R.tape)

  if (p.calendar?.length && !p.weekAhead?.length) {
    sectionHeader(c, 'On the Calendar — What to Expect', fonts)
    drawCalendar(c, p.calendar, fonts)
  }

  if (R.ideas?.length) {
    sectionHeader(c, "Today's Ideas", fonts)
    for (const idea of R.ideas) drawIdea(c, idea, fonts)
  }

  proseSection('The Short Desk', R.shortDesk)
  if (R.smallCap) proseSection('Small-Cap Wire', R.smallCap)
  proseSection('Rotation Radar', R.rotation)

  if (p.rotationTables?.length) {
    sectionHeader(c, 'Inside the Rotation', fonts)
    drawRotation(c, p.rotationTables, fonts)
  }

  if (p.socialBoard?.length) {
    sectionHeader(c, 'The Social Board', fonts)
    drawSocial(c, p.socialBoard, fonts)
  }

  if (p.ipos && ((p.ipos.upcoming?.length ?? 0) + (p.ipos.recent?.length ?? 0)) > 0) {
    sectionHeader(c, 'New Listings — Fresh on the Tape', fonts)
    drawIpos(c, p.ipos, fonts)
  }

  if (p.eventRadar?.length) {
    sectionHeader(c, 'Event Radar — Prints Ahead', fonts)
    drawEventRadar(c, p.eventRadar, fonts)
  }

  proseSection('Crypto Wire', R.crypto)
  proseSection('The Channels', R.channels)
  if (R.editorial) proseSection('The Long View', R.editorial)
  proseSection('The Honest Close', R.honestClose)
}

/** The masthead — same for both paths. */
function drawMasthead(c: Cursor, fonts: Fonts, dateLabel?: string, regime?: string): void {
  const title = 'THE STREET SIGNAL'
  const tSize = 26
  const tW = fonts.serifBold.widthOfTextAtSize(title, tSize)
  c.gap(6)
  c.need(40)
  c.y -= tSize
  c.page.drawText(title, { x: (A4.w - tW) / 2, y: c.y, size: tSize, font: fonts.serifBold, color: INK })
  const sub = sanitizeWinAnsi(`Print edition${dateLabel ? ` — ${dateLabel}` : ''}`)
  const sSize = 11
  const sW = fonts.serifItalic.widthOfTextAtSize(sub, sSize)
  c.y -= 16
  c.page.drawText(sub, { x: (A4.w - sW) / 2, y: c.y, size: sSize, font: fonts.serifItalic, color: GREY })
  if (regime) {
    const rl = sanitizeWinAnsi(`Regime — ${regime.toUpperCase()}`)
    const rSize = 9
    const rW = fonts.sansBold.widthOfTextAtSize(rl, rSize)
    c.y -= 13
    c.page.drawText(rl, { x: (A4.w - rW) / 2, y: c.y, size: rSize, font: fonts.sansBold, color: REGIME[regime] ?? GREY })
  }
  c.gap(8)
  c.rule(INK, 1.4)
  c.gap(8)
}

/** Compose the whole print edition. Returns raw PDF bytes (starts with %PDF). */
export async function composeReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts: Fonts = {
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    serifItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  }
  const c = new Cursor(doc, fonts)
  drawMasthead(c, fonts, input.dateLabel, input.print?.report?.regime)

  if (input.print) {
    // rich data path — typeset the paper from the structured payload
    drawPrintEdition(c, fonts, input.print)
  } else {
    // legacy fallback: reconstruct from the HTML (loses charts and stacked blocks)
    const blocks = htmlToBlocks(input.html)
    for (const b of blocks) {
      // the HTML masthead <h1> is "THE STREET SIGNAL" — we already printed our own
      if (b.type === 'heading' && b.level === 1 && /street signal/i.test(b.text)) continue
      if (b.type === 'heading') drawHeading(c, b.level, b.text, fonts)
      else if (b.type === 'para') drawParagraph(c, b.text, fonts)
      else drawTable(c, b.head, b.rows, fonts)
    }
  }

  return doc.save()
}
