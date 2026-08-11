// Batched daily closes via Yahoo's crumb-free spark endpoint. The core sleeve's
// cheap eye: ~7 calls cover 130 names with 3 months of closes each. Fails soft
// per chunk — a refused chunk just means those names sit out today.

const CHUNK = 20

export function parseSpark(json: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>()
  if (!json || typeof json !== 'object') return out
  for (const [sym, v] of Object.entries(json as Record<string, unknown>)) {
    const close = (v as { close?: unknown })?.close
    if (!Array.isArray(close)) continue
    const closes = close.filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
    if (closes.length) out.set(sym.toUpperCase(), closes)
  }
  return out
}

export async function fetchSparkCloses(syms: string[], fetchFn: typeof fetch = fetch): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const upper = [...new Set(syms.map(s => s.toUpperCase()))]
  for (let i = 0; i < upper.length; i += CHUNK) {
    const chunk = upper.slice(i, i + CHUNK)
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=3mo&interval=1d`
      const res = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      if (!res.ok) continue
      for (const [sym, closes] of parseSpark(await res.json())) out.set(sym, closes)
    } catch {
      /* one dead chunk must not matter */
    }
  }
  return out
}
