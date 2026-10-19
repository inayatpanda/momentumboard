// SEC EDGAR is the primary-source catalyst feed: new 8-K/10-Q/10-K/6-K
// filings arrive before a news summariser can reinterpret them. Calls are
// server-side, identified, cached by the route, and deliberately bounded.

export interface SecFiling {
  accession: string
  form: string
  filed: string
  reportDate: string
  description: string
  items: string
  url: string
}

interface TickerRow { cik_str: number; ticker: string; title: string }
interface SubmissionRecent {
  accessionNumber?: string[]
  filingDate?: string[]
  reportDate?: string[]
  form?: string[]
  primaryDocument?: string[]
  primaryDocDescription?: string[]
  items?: string[]
}

const FORMS = new Set(['8-K', '10-Q', '10-K', '6-K', '20-F', 'S-1', 'S-1/A', '424B3', '424B5', 'DEF 14A', 'SC 13D', 'SC 13D/A'])
let tickerCache: { at: number; rows: TickerRow[] } | null = null

export function parseRecentFilings(cik: number, recent: SubmissionRecent, limit = 8): SecFiling[] {
  const forms = recent.form ?? []
  const out: SecFiling[] = []
  for (let i = 0; i < forms.length && out.length < limit; i++) {
    const form = forms[i]
    const accession = recent.accessionNumber?.[i]
    const document = recent.primaryDocument?.[i]
    if (!FORMS.has(form) || !accession || !document) continue
    out.push({
      accession,
      form,
      filed: recent.filingDate?.[i] ?? '',
      reportDate: recent.reportDate?.[i] ?? '',
      description: recent.primaryDocDescription?.[i] || form,
      items: recent.items?.[i] ?? '',
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${document}`,
    })
  }
  return out
}

export async function fetchRecentFilings(
  symbol: string,
  fetchFn: typeof fetch = fetch,
  userAgent = process.env.SEC_USER_AGENT ?? 'StreetSignal thestreetsignal.rqai.co.uk',
): Promise<{ company: string | null; cik: number | null; filings: SecFiling[]; asOf: number }> {
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' }
  const company = await resolveSecCompany(symbol, fetchFn, userAgent)
  if (!company) return { company: null, cik: null, filings: [], asOf: Math.floor(Date.now() / 1000) }
  const cikPadded = String(company.cik_str).padStart(10, '0')
  const submissions = await fetchFn(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, { headers })
  if (!submissions.ok) throw new Error(`sec-submissions-${submissions.status}`)
  const body = (await submissions.json()) as { name?: string; filings?: { recent?: SubmissionRecent } }
  return {
    company: body.name ?? company.title,
    cik: company.cik_str,
    filings: parseRecentFilings(company.cik_str, body.filings?.recent ?? {}),
    asOf: Math.floor(Date.now() / 1000),
  }
}

/** Shared ticker resolution for submissions and fundamental facts. */
export async function resolveSecCompany(
  symbol: string,
  fetchFn: typeof fetch = fetch,
  userAgent = process.env.SEC_USER_AGENT ?? 'StreetSignal thestreetsignal.rqai.co.uk',
): Promise<TickerRow | null> {
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' }
  if (!tickerCache || Date.now() - tickerCache.at > 24 * 3600_000) {
    const tickerRes = await fetchFn('https://www.sec.gov/files/company_tickers.json', { headers })
    if (!tickerRes.ok) throw new Error(`sec-tickers-${tickerRes.status}`)
    const json = (await tickerRes.json()) as Record<string, TickerRow>
    tickerCache = { at: Date.now(), rows: Object.values(json) }
  }
  const wanted = symbol.trim().toUpperCase().replace('.', '-').split(':').at(-1)!
  return tickerCache.rows.find(row => row.ticker.toUpperCase() === wanted) ?? null
}
