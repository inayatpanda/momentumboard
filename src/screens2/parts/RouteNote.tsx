// RouteNote (crypto-v2 wave, finding 3) — ONE route disclaimer, both surfaces.
//
// A routed row prints entry/stop/target beside a TRACKER's ticker, and those
// levels are not the tracker's own price: they are the underlying asset's, and a
// tracker (a cETN in particular) prints its own, often differently denominated,
// number. A reader exiting on the ticker's print is exiting on the wrong number.
// That half applies to EVERY instrument.
//
// The decay half does NOT. A geared ETP rebalances daily, so a path that ends
// where it started still loses money and the engine caps the hold at ten
// sessions. A 1× tracker is the asset: no daily reset to compound, no hold
// clock — and saying nothing there left the reader to assume the warning applied
// (or, worse, that no disclaimer meant no caveat at all). So a 1× says
// explicitly that it has neither.
//
// Wording inherited from src/components/EngineBoard.tsx:140-151, which dies at
// cutover; it lives here so CallCard and VerdictHero cannot drift apart on it.

export const ROUTE_NOTE_GEARED =
  'Leveraged ETPs decay daily — max hold 10 sessions; exit on the UNDERLYING levels above, not the ETP price.'

export const ROUTE_NOTE_SPOT =
  'Tracker route — the levels above are the underlying asset’s; exit on them, not the tracker’s own print, which may be denominated differently. A 1× tracker has no daily decay and no hold clock.'

export const routeNote = (leverage: number) => (leverage > 1 ? ROUTE_NOTE_GEARED : ROUTE_NOTE_SPOT)

export function RouteNote({ instrument }: { instrument: { ticker: string; leverage: number } | null | undefined }) {
  if (!instrument) return null
  return <p className="cc-route">{routeNote(instrument.leverage)}</p>
}
