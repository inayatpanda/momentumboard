// The "print edition": a self-contained PDF of the morning paper, composed on
// Netlify with pdf-lib (pure JS — no headless browser, no rendering service, no
// new keys) and attached to the report email. The publish pipe only hands us the
// finished HTML string (see report.mts), so we reconstruct the paper from it:
// strip the tags, keep headings / paragraphs / tables in document order, and
// typeset a clean A4 broadsheet. Everything here is best-effort — report.mts
// wraps the call in try/catch so a PDF failure never blocks the email.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

export interface ReportPdfInput {
  html: string
  dateLabel?: string
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
  mono: PDFFont
  monoBold: PDFFont
}

const INK = rgb(0.098, 0.09, 0.075)
const GREY = rgb(0.42, 0.38, 0.34)

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

/** Compose the whole print edition. Returns raw PDF bytes (starts with %PDF). */
export async function composeReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts: Fonts = {
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    serifItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  }
  const c = new Cursor(doc, fonts)

  // masthead
  const title = 'THE STREET SIGNAL'
  const tSize = 26
  const tW = fonts.serifBold.widthOfTextAtSize(title, tSize)
  c.gap(6)
  c.need(34)
  c.y -= tSize
  c.page.drawText(title, { x: (A4.w - tW) / 2, y: c.y, size: tSize, font: fonts.serifBold, color: INK })
  const sub = sanitizeWinAnsi(`Print edition${input.dateLabel ? ` — ${input.dateLabel}` : ''}`)
  const sSize = 11
  const sW = fonts.serifItalic.widthOfTextAtSize(sub, sSize)
  c.y -= 16
  c.page.drawText(sub, { x: (A4.w - sW) / 2, y: c.y, size: sSize, font: fonts.serifItalic, color: GREY })
  c.gap(8)
  c.rule(INK, 1.4)
  c.gap(8)

  const blocks = htmlToBlocks(input.html)
  for (const b of blocks) {
    // the HTML masthead <h1> is "THE STREET SIGNAL" — we already printed our own
    if (b.type === 'heading' && b.level === 1 && /street signal/i.test(b.text)) continue
    if (b.type === 'heading') drawHeading(c, b.level, b.text, fonts)
    else if (b.type === 'para') drawParagraph(c, b.text, fonts)
    else drawTable(c, b.head, b.rows, fonts)
  }

  return doc.save()
}
