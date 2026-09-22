export type MarketEntityKind = 'equity' | 'crypto' | 'fx' | 'commodity' | 'private' | 'invalid'

export interface MarketEntity {
  raw: string
  symbol: string
  kind: MarketEntityKind
  tradable: boolean
  reason?: string
}

const CRYPTO_ALIASES: Record<string, string> = {
  BTC: 'BTC-USD', BITCOIN: 'BTC-USD',
  ETH: 'ETH-USD', ETHEREUM: 'ETH-USD',
  SOL: 'SOL-USD', SOLANA: 'SOL-USD',
  DOGE: 'DOGE-USD', XRP: 'XRP-USD', ADA: 'ADA-USD',
}

const CURRENCIES = new Set(['USD', 'GBP', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'CNH'])
const COMMODITIES = new Set(['GOLD', 'SILVER', 'COPPER', 'OIL', 'CRUDE', 'BRENT', 'NATGAS', 'WHEAT', 'CORN', 'SOYBEANS'])
const PRIVATE_NAMES = new Set(['SPACEX', 'OPENAI', 'ANTHROPIC', 'STRIPE', 'BYTEDANCE', 'WAYMO'])
const QUOTE_CURRENCY = /-(USD|USDT|GBP|EUR|BTC)$/
const EQUITY = /^[A-Z][A-Z0-9]{0,7}(?:[.-][A-Z0-9]{1,4})?$/

const clean = (raw: string) => raw
  .toUpperCase()
  .trim()
  .replace(/^\$/, '')
  .replace(/[()\[\],:;!?]+/g, '')

/** Resolve an extracted market mention before it becomes a stock-page route. */
export function resolveMarketEntity(raw: string): MarketEntity {
  const value = clean(raw)
  if (!value) return { raw, symbol: '', kind: 'invalid', tradable: false, reason: 'empty mention' }
  if (CRYPTO_ALIASES[value]) return { raw, symbol: CRYPTO_ALIASES[value], kind: 'crypto', tradable: true }
  if (QUOTE_CURRENCY.test(value)) return { raw, symbol: value, kind: 'crypto', tradable: true }
  if (value.includes('/')) {
    const parts = value.split('/')
    if (parts.length === 2 && parts.every(part => CURRENCIES.has(part))) return { raw, symbol: value, kind: 'fx', tradable: false, reason: 'FX pair, not an equity ticker' }
  }
  if (value.length === 6 && CURRENCIES.has(value.slice(0, 3)) && CURRENCIES.has(value.slice(3))) {
    return { raw, symbol: `${value.slice(0, 3)}/${value.slice(3)}`, kind: 'fx', tradable: false, reason: 'FX pair, not an equity ticker' }
  }
  if (CURRENCIES.has(value)) return { raw, symbol: value, kind: 'fx', tradable: false, reason: 'currency code, not an equity ticker' }
  if (COMMODITIES.has(value)) return { raw, symbol: value, kind: 'commodity', tradable: false, reason: 'commodity theme, not an equity ticker' }
  if (PRIVATE_NAMES.has(value)) return { raw, symbol: value, kind: 'private', tradable: false, reason: 'private company, no public ticker' }
  if (!EQUITY.test(value)) return { raw, symbol: value, kind: 'invalid', tradable: false, reason: 'unrecognised market symbol' }
  return { raw, symbol: value, kind: 'equity', tradable: true }
}

export const normaliseTradableMention = (raw: string): string | null => {
  const entity = resolveMarketEntity(raw)
  return entity.tradable ? entity.symbol : null
}
