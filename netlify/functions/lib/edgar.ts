// SEC EDGAR 13F reader. Institutional holdings file ~45 days after quarter end,
// so this is CONTEXT (what proven allocators accumulated), never timing.
import type { SmartMoneyInput } from '../../../shared/engine/factors'

const UA = { 'User-Agent': 'MomentumBoard research inayatc2002@gmail.com' }

// CIKs verified against data.sec.gov/submissions on 2026-07-10, roster growth
// re-verified 2026-07-15 — every entry below has current 13F-HR filings
// (latest 2026-05-15) EXCEPT Scion: Burry deregistered the adviser and last
// filed 2025-11-03; kept deliberately (his last book is still read), the UI
// marks the row stale. A wrong CIK silently poisons the smart-money factor, so
// verify before adding. Note Einhorn: the old GREENLIGHT CAPITAL INC filer
// (0001079114) stopped filing Feb 2024; his current filer entity is DME
// Capital Management, LP (0001489933). Point72/Citadel/RenTech are excluded on
// purpose — thousand-position pod books are diff noise, not conviction.
export const FUNDS = [
  { cik: '0001067983', name: 'Berkshire Hathaway' },
  { cik: '0001336528', name: 'Pershing Square' },
  { cik: '0001649339', name: 'Scion Asset Management' },
  { cik: '0001536411', name: 'Duquesne Family Office' },
  { cik: '0001061768', name: 'Baupost Group' },
  { cik: '0001656456', name: 'Appaloosa (Tepper)' },
  { cik: '0001040273', name: 'Third Point' },
  { cik: '0001489933', name: 'Greenlight (Einhorn)' },
  { cik: '0001167483', name: 'Tiger Global' },
  { cik: '0001135730', name: 'Coatue Management' },
  { cik: '0001350694', name: 'Bridgewater (Dalio)' },
  { cik: '0000921669', name: 'Icahn (Carl Icahn)' },
  { cik: '0001029160', name: 'Soros Fund Management' },
  { cik: '0001791786', name: 'Elliott Management' },
  { cik: '0001569205', name: 'Fundsmith (Terry Smith)' },
]

export interface Holding {
  issuer: string
  shares: number
  value: number // as reported
}

export interface FundMoves {
  fund: string
  filedAt: string
  newPositions: Holding[]
  increased: (Holding & { pctChange: number })[]
  exited: Holding[]
}

export function parseInfoTable(xml: string): Holding[] {
  const byIssuer = new Map<string, Holding>()
  const blocks = xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/g) ?? []
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  for (const b of blocks) {
    // A put, call or debt principal is not an outright share holding.
    if (/<(?:\w+:)?putCall>\s*(?:PUT|CALL)\s*<\/(?:\w+:)?putCall>/i.test(b) || /<(?:\w+:)?sshPrnamtType>\s*PRN\s*<\/(?:\w+:)?sshPrnamtType>/i.test(b)) continue
    const issuer = decode(b.match(/<(?:\w+:)?nameOfIssuer>([\s\S]*?)<\/(?:\w+:)?nameOfIssuer>/)?.[1]?.trim() ?? '')
    const value = Number(b.match(/<(?:\w+:)?value>(\d+)<\/(?:\w+:)?value>/)?.[1])
    const shares = Number(b.match(/<(?:\w+:)?sshPrnamt>(\d+)<\/(?:\w+:)?sshPrnamt>/)?.[1])
    if (!issuer || !Number.isFinite(value)) continue
    const cur = byIssuer.get(issuer) ?? { issuer, shares: 0, value: 0 }
    cur.shares += Number.isFinite(shares) ? shares : 0
    cur.value += value
    byIssuer.set(issuer, cur)
  }
  return [...byIssuer.values()]
}

/** Quarters spell the same issuer differently ("CHEVRON CORP" one filing,
 * "CHEVRON CORP NEW" the next) — a raw-string diff turned every respelling
 * into a phantom NEW + EXITED pair (Berkshire "bought Chevron, sold Chevron
 * Corp New"). Diff on the normalised issuer instead; share classes that
 * normalise together merge, keeping the current filing's display name. */
function byNormIssuer(hs: Holding[]): Map<string, Holding> {
  const out = new Map<string, Holding>()
  for (const h of hs) {
    const k = normIssuer(h.issuer)
    if (!k) continue
    const cur = out.get(k)
    if (cur) {
      cur.shares += h.shares
      cur.value += h.value
    } else out.set(k, { ...h })
  }
  return out
}

export function diff13F(fund: string, filedAt: string, current: Holding[], prior: Holding[]): FundMoves {
  const prevBy = byNormIssuer(prior)
  const curBy = byNormIssuer(current)
  const top = <T extends Holding>(xs: T[]) => xs.sort((a, b) => b.value - a.value).slice(0, 5)
  return {
    fund,
    filedAt,
    newPositions: top([...curBy.entries()].filter(([k]) => !prevBy.has(k)).map(([, h]) => h)),
    increased: top(
      [...curBy.entries()]
        .filter(([k, h]) => {
          const p = prevBy.get(k)
          return p && p.shares > 0 && h.shares > p.shares * 1.2
        })
        .map(([k, h]) => ({ ...h, pctChange: Math.round(((h.shares - prevBy.get(k)!.shares) / prevBy.get(k)!.shares) * 100) })),
    ),
    exited: top([...prevBy.entries()].filter(([k]) => !curBy.has(k)).map(([, h]) => h)),
  }
}

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers: UA })
  if (!res.ok) throw new Error(`edgar-${res.status}`)
  return res.json()
}

export async function fetchFundMoves(cik: string, name: string, fetchFn: typeof fetch = fetch): Promise<FundMoves | null> {
  try {
    const sub = (await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, fetchFn)) as {
      filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[] } }
    }
    const r = sub.filings.recent
    const idx: number[] = []
    for (let i = 0; i < r.form.length && idx.length < 2; i++) if (r.form[i] === '13F-HR') idx.push(i)
    if (idx.length < 2) return null

    const holdingsFor = async (i: number): Promise<Holding[]> => {
      const accn = r.accessionNumber[i].replace(/-/g, '')
      const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn}`
      const index = (await fetchJson(`${dir}/index.json`, fetchFn)) as { directory: { item: { name: string }[] } }
      const xmlFile = index.directory.item.find(f => /\.xml$/i.test(f.name) && !/primary_doc/i.test(f.name))
      if (!xmlFile) throw new Error('13F information table missing')
      const res = await fetchFn(`${dir}/${xmlFile.name}`, { headers: UA })
      if (!res.ok) throw new Error(`13F information table HTTP ${res.status}`)
      const holdings = parseInfoTable(await res.text())
      if (!holdings.length) throw new Error('13F equity holdings unavailable')
      return holdings
    }

    const [current, prior] = await Promise.all([holdingsFor(idx[0]), holdingsFor(idx[1])])
    if (!current.length) return null
    return diff13F(name, r.filingDate[idx[0]], current, prior)
  } catch {
    return null
  }
}

export async function fetchAllFundMoves(fetchFn: typeof fetch = fetch): Promise<FundMoves[]> {
  const out: FundMoves[] = []
  for (const f of FUNDS) {
    const m = await fetchFundMoves(f.cik, f.name, fetchFn) // sequential — SEC asks for gentle, single-threaded access
    if (m) out.push(m)
  }
  // freshest filings first: a fund that stopped filing (Scion after Burry
  // deregistered) sinks to the bottom instead of sitting mid-list looking broken
  return out.sort((a, b) => b.filedAt.localeCompare(a.filedAt))
}

/** 13F moves change only on filing (~quarterly), so a 12h cache keeps the daily
 * sweep from re-walking EDGAR every run while staying SEC-polite. edgar.ts had
 * no cache before — this is the one referenced by the engine dep. */
export async function cachedFundMoves(fetchFn: typeof fetch = fetch): Promise<FundMoves[]> {
  const { getCached, setCached } = await import('./cache')
  const KEY = 'edgar:fund-moves:v4' // Exclude options/debt and require both comparable filings.
  const hit = await getCached<FundMoves[]>(KEY)
  if (hit) return hit
  const moves = await fetchAllFundMoves(fetchFn)
  if (moves.length) await setCached(KEY, moves, 12 * 3600)
  return moves
}

// ---- 13F issuer-name → roster-ticker matching ----
//
// 13F rows carry issuer NAMES (often SEC-abbreviated: "BANK AMER CORP",
// "OCCIDENTAL PETE"), not tickers. Match conservatively: a MISSED match is
// fine, a WRONG match is not. Two paths, both token-boundary safe:
//   1. a curated ticker→issuer alias map (handles the abbreviated mega-caps)
//   2. exact normalised equality with the Finnhub profile2 `name` (cap: cache)
// Anything else → no match → the factor stays null for that name.

const CORP_NOISE = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|COS|LTD|LIMITED|PLC|LLC|LP|HLDG|HLDGS|HOLDING|HOLDINGS|GROUP|GRP|TR|TRUST|CL|CLASS|COM|COMMON|SHS|SHARES|CAP|STK|NEW|THE|NV|SA|AG|USA|US|DEL)\b/g

export function normIssuer(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(CORP_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ [ABC]$/, '') // drop a trailing share-class letter ("ALPHABET A", "META PLATFORMS A")
}

// Curated aliases keyed by ticker → the EXACT normalised SEC issuer form(s). We
// match by exact normalised equality (not prefix), so 'APPLE' can never grab
// "Apple Hospitality REIT". Multiple values cover SEC's spelling variants.
const SMART_MONEY_ALIASES: Record<string, string[]> = {
  AAPL: ['APPLE'],
  BAC: ['BANK AMER', 'BANK OF AMERICA', 'BANKAMERICA'],
  KO: ['COCA COLA'],
  CVX: ['CHEVRON'],
  OXY: ['OCCIDENTAL PETE', 'OCCIDENTAL PETROLEUM'],
  AXP: ['AMERICAN EXPRESS', 'AMER EXPRESS'],
  KHC: ['KRAFT HEINZ'],
  MCO: ['MOODYS'],
  CB: ['CHUBB'],
  DVA: ['DAVITA'],
  KR: ['KROGER'],
  VRSN: ['VERISIGN'],
  V: ['VISA'],
  MA: ['MASTERCARD'],
  AMZN: ['AMAZON'],
  NVDA: ['NVIDIA'],
  GOOGL: ['ALPHABET'],
  GOOG: ['ALPHABET'],
  META: ['META PLATFORMS'],
  MSFT: ['MICROSOFT'],
  CMG: ['CHIPOTLE MEXICAN GRILL', 'CHIPOTLE MEXICAN'],
  QSR: ['RESTAURANT BRANDS INTL', 'RESTAURANT BRANDS INTERNATIONAL'],
  HLT: ['HILTON WORLDWIDE'],
  NKE: ['NIKE'],
  HHH: ['HOWARD HUGHES'],
  BABA: ['ALIBABA'],
  UBER: ['UBER TECHNOLOGIES', 'UBER TECH'],
  SIRI: ['SIRIUS XM', 'SIRIUS XM HLDGS'],
  LPX: ['LOUISIANA PAC', 'LOUISIANA PACIFIC'],
  ALLY: ['ALLY FINL', 'ALLY FINANCIAL'],
  C: ['CITIGROUP'],
  LEN: ['LENNAR'],
  DHI: ['D R HORTON', 'HORTON D R'],
  PHM: ['PULTEGROUP'],
  DPZ: ['DOMINOS PIZZA'],
  POOL: ['POOL'],
}

const baseTicker = (sym: string) => sym.split('.')[0].split('-')[0].toUpperCase()

/** Conservative issuer↔ticker test: exact normalised equality against a curated
 * alias OR against the Finnhub company name. No prefix/substring matching — a
 * missed match is acceptable, a wrong one is not. */
export function matchesIssuer(sym: string, companyName: string | null, issuerNorm: string): boolean {
  if (!issuerNorm) return false
  const aliases = SMART_MONEY_ALIASES[baseTicker(sym)]
  if (aliases && aliases.some(a => normIssuer(a) === issuerNorm)) return true
  if (companyName) {
    const cn = normIssuer(companyName)
    if (cn.length >= 4 && cn === issuerNorm) return true
  }
  return false
}

/** Per-symbol 13F overlap against the tracked funds' latest moves, or null if no
 * confident match. bought = funds that newly bought or increased; exited = funds
 * that sold out entirely. */
export function matchSmartMoney(sym: string, companyName: string | null, moves: FundMoves[]): SmartMoneyInput | null {
  const bought = new Set<string>()
  const exited = new Set<string>()
  let filedAt = ''
  for (const m of moves) {
    const hits = (hs: Holding[]) => hs.some(h => matchesIssuer(sym, companyName, normIssuer(h.issuer)))
    const b = hits(m.newPositions) || hits(m.increased)
    const e = hits(m.exited)
    if (b) bought.add(m.fund)
    if (e) exited.add(m.fund)
    if ((b || e) && m.filedAt > filedAt) filedAt = m.filedAt
  }
  if (!bought.size && !exited.size) return null
  return { bought: [...bought], exited: [...exited], filedAt }
}
