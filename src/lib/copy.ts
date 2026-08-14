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

/** …AND THE OBSERVATION-ONLY DAY, which is a different fact told with the same
 * sentence until now (T13a). A board carrying observations and watch rows has
 * rows that DID clear the gates — the observation row's whole definition is
 * "cleared every gate, but no ISA route exists to place it". Printing "nothing
 * cleared its gates" above three such rows contradicts the list underneath it,
 * in the reader's own field of view, about the one thing this app sells: that
 * the engine says what actually happened. */
export const NO_SIZED_NO_ROUTE = 'Nothing sized today — what cleared the gates has no route an ISA can take.'

/** The slice resolved and there IS no board (a cold store, or a weekday
 * morning before the engine's run) — said out loud, never a skeleton that
 * looks hung (walkthrough finding A1). */
export const NO_BOARD_YET = 'No board yet — the engine publishes on weekday mornings.'
