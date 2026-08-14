// Copy the client composes for itself — kept out of components so a screen
// never freehands the words for a state as consequential as "the engine
// looked and published nothing sized". This is the CLIENT's own sentence, not
// a read of the paper: it mirrors the spirit of `boardFootnote` in
// netlify/functions/lib/newspaper.ts (which explains a board that shipped
// with nothing sized on it, "An honest empty board beats a forced call" —
// see also the old src/components/EngineBoard.tsx:239) without importing
// from it or editing it. Two different surfaces, two copies of one idea, by
// design — the paper's prose stays the paper's own.
export const NO_SIZED_TODAY = 'Nothing sized today. The engine scanned, and nothing cleared its gates.'
