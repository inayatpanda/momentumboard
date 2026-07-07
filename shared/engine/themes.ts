// THEMES: the tapes the reader actually hunts — energy & power, chips, data
// centres, robotics, drones. Sector ETFs cover the S&P megacaps; these lists
// reach the mid/small caps that ARE the theme trade. Three jobs, none of them
// a score: (1) identification — every call carries its theme tags; (2) supply —
// hot-theme members join the daily candidate pool as one more inflow, gated
// and priced like any screener row (a theme earns a call, it's never handed
// one); (3) diversity — names without a sector-ETF mapping group by theme in
// the board's diversity gate, so five correlated drone small caps can't wear
// five hats.
//
// Lists are curated and liquid-biased; staleness is safe — a dead name simply
// fails the roster's capacity/liquidity gates. Keyword heat is crude on
// purpose, same as the news factor: titles in, counts out, nuance is the LLM
// overlay's job.

export interface ThemeDef {
  key: string
  name: string
  members: string[]
  keywords: string[] // matched lowercased against headline titles
}

export const THEMES: ThemeDef[] = [
  {
    key: 'energy',
    name: 'Energy & power',
    members: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'CEG', 'VST', 'NRG', 'TLN', 'OKLO', 'SMR', 'NNE', 'CCJ', 'UEC', 'LEU', 'BWXT', 'FSLR', 'GEV'],
    keywords: ['energy', 'oil', 'crude', 'opec', 'nuclear', 'uranium', 'reactor', 'power grid', 'electricity', 'megawatt', 'gigawatt'],
  },
  {
    key: 'chips',
    name: 'Chips',
    members: ['NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'AMAT', 'LRCX', 'KLAC', 'MU', 'MRVL', 'ARM', 'QCOM', 'INTC', 'TXN', 'ADI', 'MPWR', 'ONTO', 'ALAB', 'CRDO', 'SITM', 'RMBS'],
    keywords: ['chip', 'chips', 'semiconductor', 'semiconductors', 'foundry', 'gpu', 'gpus', 'silicon', 'wafer', 'lithography'],
  },
  {
    key: 'datacentre',
    name: 'Data centres & AI infra',
    members: ['SMCI', 'DELL', 'HPE', 'VRT', 'ETN', 'ANET', 'CIEN', 'COHR', 'LITE', 'NBIS', 'CRWV', 'APLD', 'WULF', 'IREN', 'HUT', 'DLR', 'EQIX', 'MOD', 'POWL'],
    keywords: ['data center', 'data centre', 'datacenter', 'hyperscaler', 'ai infrastructure', 'cloud capex', 'compute capacity', 'server'],
  },
  {
    key: 'robotics',
    name: 'Robotics & automation',
    members: ['ISRG', 'SYM', 'ROK', 'TER', 'ZBRA', 'CGNX', 'PATH', 'SERV', 'RR', 'NDSN'],
    keywords: ['robot', 'robots', 'robotics', 'humanoid', 'automation', 'autonomous factory'],
  },
  {
    key: 'drones',
    name: 'Drones & autonomy',
    members: ['AVAV', 'KTOS', 'RCAT', 'ONDS', 'UMAC', 'DPRO', 'ACHR', 'JOBY', 'EH'],
    keywords: ['drone', 'drones', 'uav', 'counter-drone', 'evtol', 'air taxi', 'unmanned'],
  },
]

const memberIndex = (() => {
  const m = new Map<string, string[]>()
  for (const t of THEMES) for (const sym of t.members) m.set(sym, [...(m.get(sym) ?? []), t.key])
  return m
})()

/** Theme keys a symbol belongs to (a name can wear two hats — SMCI is chips
 * AND data centres). Empty array = unthemed. */
export const themesOf = (sym: string): string[] => memberIndex.get(sym.toUpperCase()) ?? []

/** First theme, for grouping in the diversity gate. */
export const primaryThemeOf = (sym: string): string | null => themesOf(sym)[0] ?? null

export interface ThemeHeat {
  key: string
  name: string
  hits: number
}

/** How loudly each theme is in today's headlines: keyword occurrences across
 * titles, one hit per keyword per title. Sorted hottest first; ties keep the
 * THEMES declaration order (deterministic). */
export function themeHeat(titles: string[]): ThemeHeat[] {
  const lower = titles.map(t => t.toLowerCase())
  return THEMES.map(t => ({
    key: t.key,
    name: t.name,
    hits: lower.reduce((s, title) => s + t.keywords.reduce((k, kw) => k + (title.includes(kw) ? 1 : 0), 0), 0),
  })).sort((a, b) => b.hits - a.hits)
}

/** The daily theme inflow for the candidate pool: members of the hottest
 * themes, hottest first, capped per theme and in total. Quiet weeks still
 * scan every theme a little (heat 0 keeps declaration order) — "focus themes"
 * means always watched, not only when loud. */
export function themeCandidates(titles: string[], perTheme = 8, total = 24): { sym: string; theme: string }[] {
  const heat = themeHeat(titles)
  const out: { sym: string; theme: string }[] = []
  const seen = new Set<string>()
  for (const h of heat) {
    const def = THEMES.find(t => t.key === h.key)!
    for (const sym of def.members.slice(0, perTheme)) {
      if (out.length >= total) return out
      if (seen.has(sym)) continue
      seen.add(sym)
      out.push({ sym, theme: h.key })
    }
  }
  return out
}
