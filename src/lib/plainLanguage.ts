/** Presentation labels only: saved strategy identifiers and calculations stay stable. */
const STRATEGIES: Record<string, string> = {
  'short-horizon': 'Short-term direction', 'quality-dip': 'Recovery after a fall',
  'social-ignition': 'Growing attention', 'macro-event': 'Major market events',
  'composite-control': 'Published predictions',
  'direction-core': 'Short-term direction', 'direction-gated': 'Direction with extra checks',
  'pullback-price': 'Price recovering after a fall', 'trend-price': 'Stocks with a rising trend',
  'big-drop-price': 'Big price falls', 'healthy-drop': 'Strong businesses after big falls',
  'healthy-value-drop': 'Strong businesses after falls, with price checks',
  'quality-trend': 'Strong businesses with rising prices', 'quality-value': 'Strong businesses with price checks',
}
export const strategyName = (key: string, fallback = key) => STRATEGIES[key] ?? fallback
export const holdingPeriod = (sessions: number) => sessions === 63 ? 'About 3 months' : sessions === 20 || sessions === 21 ? 'About 1 month' : `${sessions} trading days`
export const businessStatus = (value: unknown) => value === 'healthy' ? 'Passes our financial checks' : (value === 'fragile' || value === 'deteriorating') ? 'Financial concerns' : value === 'mixed' ? 'Mixed financial picture' : 'Not enough information'
export const reportStatus = (value: unknown) => value === 'improving' ? 'Improving' : value === 'deteriorating' ? 'Getting weaker' : value === 'stable' ? 'Steady' : value === 'mixed' ? 'Mixed picture' : 'Not enough reports'
export const directionName = (side: string) => side === 'long' ? 'Expecting a rise' : side === 'short' ? 'Expecting a fall' : 'No clear direction'

const RESEARCH_WORDING: Record<string, string> = {
  'earnings fall inside the engine risk window; a gap can overwhelm a three-session model': 'Company results are due soon and could cause a sudden price jump or fall.',
  'the three-session move is already extended, increasing reversal and gap risk': 'The price has already moved sharply. It could reverse suddenly.',
  'neither direction clears the historical frequency, uncertainty, similarity, base-rate improvement and median-move gates': 'Past examples do not give enough support for either a rise or a fall.',
  'fewer than 20 usable analogues or the current state is too far from prior states; no supported directional setup': 'There are too few similar past examples to support a direction.',
  'historical frequencies and intervals are descriptive; predictive skill must be earned in forward forecasts': 'Past patterns may not repeat. We still need results from predictions saved in advance.',
  'live pre-market gaps, options positioning and intraday order flow are not in this daily-close forecast': 'This view uses daily closing prices. It does not include changes before the market opens or trading within the day.',
  'earnings are inside the near-term risk window; wait for the event before a setup': 'Company results are due soon. Wait for the report before reassessing this idea.',
  'repeated weakening report comparisons override the latest standalone healthy screen': 'Several company reports show weakening results, even though the latest financial checks pass.',
  'severe drawdown or ongoing sharp selling; a healthy historical filing does not stop a falling price': 'The share price is still falling sharply. Healthy past accounts do not guarantee a recovery.',
  'unique-author, engagement-quality and coordinated-promotion detection need source-level feeds': 'We cannot yet reliably check who is behind the attention or whether promotions are coordinated.',
  'the recovery scenario does not offer 1.5× reward/risk within an 18% stop distance': 'The possible gain is too small for the planned risk, or the loss limit is too far away.',
  'earnings are inside the near-term calendar; wait for the report or reassess gap risk': 'Company results are due soon. The share price could change sharply when they arrive.',
  'forward estimate revisions and the cause of the drawdown require independent review; valuation uses last annual results, not forward earnings': 'Future earnings and the reason for the fall still need checking. Price checks use last year’s results.',
  'the cause of the selloff is not independently established': 'The reason for the price fall is not yet confirmed.',
  'Sector leverage needs dated cash, debt (or an explicit total-liabilities upper bound) and positive annual operating cash flow.': 'There is not enough dated information about cash, debt and cash flow to check borrowing risk.',
}
/** Exact translations only; unfamiliar source wording is preserved for review. */
export const researchWording = (text: string) => RESEARCH_WORDING[text] ?? text
export const nextCheckWording = (label: string, fallback: string) => ({
  'Business health': 'Check the latest profits, cash and debt.',
  'Valuation': 'Check whether the share price is reasonable for this business.',
  'Report trend': 'Look for steady or improving company results.',
  'Chart confirmation': 'Look for signs that the share price has stopped falling.',
  'Selloff cause': 'Establish why the price fell and whether the damage could last.',
  'Risk and events': 'Review the potential loss and upcoming company results.',
} as Record<string, string>)[label] ?? fallback
