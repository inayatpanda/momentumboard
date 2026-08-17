// MarkdownLite (visibility wave, 2026-08-17) — the smallest honest renderer
// for the ONE markdown dialect the desk's LLM writers actually emit: bold
// spans and numbered / dashed line breaks. Nothing else.
//
// WHY NOT A LIBRARY. Every markdown package on npm parses far more than the
// engine ever writes (tables, links, raw HTML passthrough) and the ones that
// are small enough to justify hand back an HTML string, which would have to
// reach the DOM through dangerouslySetInnerHTML — an injection door opened for
// prose that is, by construction, model output. This builds React NODES: every
// character of the source ends up inside a text node React escapes, so the
// worst a hostile assessment can do is render its own angle brackets.
//
// WHAT COUNTS AS A BREAK, and why those two only:
//   `1. ` … `12. `  a numbered step, when the digits start a word (preceded by
//                   whitespace or the string start, so "2026." and "$82.95"
//                   are never mistaken for one)
//   ` - `           a dashed bullet. The desk's own prose uses the EM dash
//                   (—) throughout, never a spaced hyphen, so this marker
//                   cannot collide with a sentence the engine wrote.
// Real newlines break too; HTML collapses them, which is exactly why an
// assessment written as a numbered list arrived on screen as one paragraph.

export interface MdBlock {
  kind: 'para' | 'bullet' | 'number'
  /** the printed marker for a numbered step ("2."), null for anything else */
  marker: string | null
  text: string
}

/** `(?:^|\s)` is load-bearing: it forces the digits to START a word. Without
 * it "2026. Traders" matches as step 26 and the sentence loses its year. */
const MARKER_RE = /(?:^|\s)(?:(\d{1,2})\.|-)\s+/g

export function splitBlocks(raw: string): MdBlock[] {
  const out: MdBlock[] = []
  for (const line of String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')) {
    if (!line.trim()) continue
    MARKER_RE.lastIndex = 0
    let cursor = 0
    let pending: { kind: MdBlock['kind']; marker: string | null } = { kind: 'para', marker: null }
    let m: RegExpExecArray | null
    while ((m = MARKER_RE.exec(line)) !== null) {
      const before = line.slice(cursor, m.index).trim()
      if (before) out.push({ ...pending, text: before })
      pending = m[1] ? { kind: 'number', marker: `${m[1]}.` } : { kind: 'bullet', marker: null }
      cursor = MARKER_RE.lastIndex
    }
    const tail = line.slice(cursor).trim()
    if (tail) out.push({ ...pending, text: tail })
  }
  return out
}

export interface MdPart {
  bold: boolean
  text: string
}

/** `**bold**` only. An unpaired `**` stays literal rather than swallowing the
 * rest of the paragraph into a strong tag that never closes. */
export function inlineParts(text: string): MdPart[] {
  const parts: MdPart[] = []
  const re = /\*\*([^*]+?)\*\*/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) parts.push({ bold: false, text: text.slice(cursor, m.index) })
    parts.push({ bold: true, text: m[1] })
    cursor = re.lastIndex
  }
  if (cursor < text.length) parts.push({ bold: false, text: text.slice(cursor) })
  return parts
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const blocks = splitBlocks(text)
  if (blocks.length === 0) return null
  return (
    <div className={`md-lite${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => (
        <p className={`md-lite-line md-lite-${b.kind}`} key={i}>
          {b.marker && (
            <span className="num md-lite-marker" aria-hidden="true">
              {b.marker}
            </span>
          )}
          {b.kind === 'bullet' && (
            <span className="md-lite-marker" aria-hidden="true">
              ·
            </span>
          )}
          {inlineParts(b.text).map((p, j) => (p.bold ? <strong key={j}>{p.text}</strong> : <span key={j}>{p.text}</span>))}
        </p>
      ))}
    </div>
  )
}
