// Copy the client composes for itself — kept out of components so a screen
// never freehands the words for a state as consequential as "the engine
// looked and published nothing sized". This is the CLIENT's own sentence, not
// a read of the paper: it mirrors the spirit of `boardFootnote` in
// netlify/functions/lib/newspaper.ts (which explains a board that shipped
// with nothing sized on it, "An honest empty board beats a forced call" —
// see also the old src/components/EngineBoard.tsx:239) without importing
// from it or editing it. Two different surfaces, two copies of one idea, by
// design — the paper's prose stays the paper's own.
export const NO_SIZED_TODAY = 'No trade plans today. The scan found no ideas that passed all the required checks.'

/** …AND THE OBSERVATION-ONLY DAY, which is a different fact told with the same
 * sentence until now (T13a). A board carrying observations and watch rows has
 * rows that DID clear the gates — the observation row's whole definition is
 * "cleared every gate, but no ISA route exists to place it". Printing "nothing
 * cleared its gates" above three such rows contradicts the list underneath it,
 * in the reader's own field of view, about the one thing this app sells: that
 * the engine says what actually happened. */
export const NO_SIZED_NO_ROUTE = 'No trade plans today. Some ideas are still being watched, or have no suitable ISA investment available.'

/** The slice resolved and there IS no board (a cold store, or a weekday
 * morning before the engine's run) — said out loud, never a skeleton that
 * looks hung (walkthrough finding A1). */
export const NO_BOARD_YET = 'No predictions published yet. Check again after the weekday morning update.'

/** THE CRYPTO WIRE'S STANDING LINE (owner, 2026-08-17: "i dont see any crpto
 * information anywhere"). Every crypto number in this app was struck on a
 * different partition, and a reader shown a price and a stance with no basis
 * beside them is being told something false by omission — the same argument
 * CohortMarks.tsx makes for the row's own disclosure.
 *
 * The two facts are the engine's own, said here in the client's words: the
 * cohort's grade is the raw side-adjusted move over fourteen crypto bars with
 * no benchmark subtracted (shared/engine/cryptoCalibration.ts; Record's cohort
 * pane and newspaper.ts's footnote each say it for their own surface), and a
 * coin itself is not an ISA-holdable instrument — a crypto row is analysis
 * unless a tracker route happens to be configured for the pair, which is why
 * the lane's rows carry `paperOnly`. */
export const CRYPTO_BASIS =
  'Crypto results are measured separately over 14 price periods, without a stock-market comparison. Coins cannot be held directly in an ISA.'

/** …and the day the board carries no coin at all. The wire still renders: a
 * lane that vanishes when it is quiet is how crypto became invisible in an app
 * that prices it every morning. */
export const NO_CRYPTO_TODAY = "No crypto ideas met the checks in today’s scan."
