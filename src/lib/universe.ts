// Category universes: the browsable market behind each watchlist chip. The
// personal watchlist stays small (30 cap) — these are the "way more stocks"
// a category can SHOW: tap a chip, see your own names first, then the rest of
// the sector with live quotes and one-tap Add, split big caps / small caps.
// Curated for liquidity and deliberately overlapping (NVDA is Megacap, Chips
// AND AI — that's simply true). Small-cap picks lean momentum-tradeable, in
// keeping with the engine's small-cap sleeve.

export interface CategoryUniverse {
  big: string[]
  small: string[]
}

export const CATEGORY_UNIVERSE: Record<string, CategoryUniverse> = {
  Megacap: {
    big: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'LLY', 'JPM', 'V', 'UNH', 'WMT', 'NFLX'],
    small: [],
  },
  Chips: {
    big: ['NVDA', 'AMD', 'AVGO', 'TSM', 'MU', 'QCOM', 'ARM', 'ASML', 'LRCX', 'AMAT', 'KLAC', 'MRVL', 'INTC', 'TXN', 'SMCI', 'ON'],
    small: ['LSCC', 'ACLS', 'FORM', 'SITM', 'AEHR', 'SKYT', 'INDI', 'WOLF'],
  },
  'AI & Data centres': {
    big: ['NVDA', 'MSFT', 'GOOGL', 'ORCL', 'SMCI', 'VRT', 'ANET', 'DLR', 'EQIX', 'PWR', 'PLTR', 'CEG', 'VST'],
    small: ['APLD', 'IREN', 'NBIS', 'CORZ', 'AI', 'BBAI', 'SOUN'],
  },
  'Software & cloud': {
    big: ['CRM', 'NOW', 'ADBE', 'SNOW', 'SHOP', 'INTU', 'PANW', 'CRWD', 'DDOG', 'NET', 'MDB'],
    small: ['GTLB', 'S', 'FSLY', 'DOCN', 'BRZE'],
  },
  Energy: {
    big: ['XOM', 'CVX', 'COP', 'SLB', 'OXY', 'EOG', 'DVN', 'SHEL', 'BP', 'CEG', 'VST', 'NEE', 'FSLR'],
    small: ['OKLO', 'SMR', 'UEC', 'NOG', 'SM', 'TALO', 'BTU', 'ENPH'],
  },
  Defence: {
    big: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'LDOS', 'HII', 'TXT', 'PLTR'],
    small: ['AVAV', 'KTOS', 'RCAT', 'ONDS', 'ACHR'],
  },
  Biotech: {
    big: ['LLY', 'NVO', 'AMGN', 'GILD', 'VRTX', 'REGN', 'MRNA', 'BIIB'],
    small: ['CRSP', 'NTLA', 'BEAM', 'RXRX', 'VKTX', 'IOVA'],
  },
  'Banks & fintech': {
    big: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'V', 'MA', 'AXP', 'BLK'],
    small: ['SOFI', 'AFRM', 'UPST', 'LC'],
  },
  'Autos & EV': {
    big: ['TSLA', 'TM', 'F', 'GM', 'HMC', 'RACE'],
    small: ['RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'CHPT'],
  },
  'Gold & miners': {
    big: ['GLD', 'NEM', 'GOLD', 'AEM', 'FNV', 'WPM'],
    small: ['AG', 'HL', 'CDE', 'EXK', 'SILV'],
  },
  Crypto: {
    big: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'COIN', 'MSTR', 'HOOD'],
    small: ['MARA', 'RIOT', 'CLSK', 'CIFR', 'HUT', 'BITF'],
  },
  Index: {
    big: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', '^FTSE', '^GDAXI', '^N225'],
    small: [],
  },
  UK: {
    big: ['RR.L', 'BP.L', 'SHEL.L', 'AZN.L', 'HSBA.L', 'BARC.L', 'LLOY.L', 'VOD.L', 'GLEN.L', 'BA.L', 'ULVR.L', 'REL.L'],
    small: ['ITV.L', 'ASC.L', 'BOO.L'],
  },
}

/** Chip order: universe categories first (stable), then any custom categories
 * the user invented that the universe doesn't know. */
export function categoryChips(userCategories: string[]): string[] {
  const known = Object.keys(CATEGORY_UNIVERSE)
  const custom = userCategories.filter(c => !known.includes(c))
  return [...known, ...custom]
}
