// SEC EDGAR 13F reader. Institutional holdings file ~45 days after quarter end,
// so this is CONTEXT (what proven allocators accumulated), never timing.
const UA = { 'User-Agent': 'MomentumBoard research inayatc2002@gmail.com' }

export const FUNDS = [
  { cik: '0001067983', name: 'Berkshire Hathaway' },
  { cik: '0001336528', name: 'Pershing Square' },
  { cik: '0001649339', name: 'Scion Asset Management' },
  { cik: '0001536411', name: 'Duquesne Family Office' },
  { cik: '0001061768', name: 'Baupost Group' },
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

export function diff13F(fund: string, filedAt: string, current: Holding[], prior: Holding[]): FundMoves {
  const prevBy = new Map(prior.map(h => [h.issuer, h]))
  const curBy = new Map(current.map(h => [h.issuer, h]))
  const top = <T extends Holding>(xs: T[]) => xs.sort((a, b) => b.value - a.value).slice(0, 5)
  return {
    fund,
    filedAt,
    newPositions: top(current.filter(h => !prevBy.has(h.issuer))),
    increased: top(
      current
        .filter(h => {
          const p = prevBy.get(h.issuer)
          return p && p.shares > 0 && h.shares > p.shares * 1.2
        })
        .map(h => ({ ...h, pctChange: Math.round(((h.shares - prevBy.get(h.issuer)!.shares) / prevBy.get(h.issuer)!.shares) * 100) })),
    ),
    exited: top(prior.filter(h => !curBy.has(h.issuer))),
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
      if (!xmlFile) return []
      const res = await fetchFn(`${dir}/${xmlFile.name}`, { headers: UA })
      return parseInfoTable(await res.text())
    }

    const [current, prior] = await Promise.all([holdingsFor(idx[0]), holdingsFor(idx[1])])
    if (!current.length) return null
    return diff13F(name, r.filingDate[idx[0]], current, prior)
  } catch {
    return null
  }
}
