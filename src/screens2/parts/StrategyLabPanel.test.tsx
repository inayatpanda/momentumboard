import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import type { EngineLabSnapshot, StrategyObservation } from '../../../shared/engine/strategyLab'
import { StrategyLabPanel } from './StrategyLabPanel'

const short: StrategyObservation = {
  id: 'short:GOOGL:2026-08-21',
  sleeve: 'short-horizon',
  sym: 'GOOGL',
  side: 'long',
  state: 'setup',
  score: 73,
  entry: 201,
  stop: null,
  target: null,
  detectedAt: 1,
  availableAt: 1,
  reasons: ['similar historical states finished higher 7 times', 'volume is expanding'],
  risks: ['earnings are inside the forecast window'],
  dataGaps: ['social breadth not confirmed'],
  metrics: {},
  forecast: {
    definition: 'three-session-direction-v1',
    label: 'three-session direction',
    horizonSessions: 3,
    probabilityUp: 0.64,
    probabilityDown: 0.29,
    probabilityFlat: 0.07,
    expectedMovePct: 1.8,
    expectedLowPct: -1.2,
    expectedHighPct: 4.6,
    calibratedN: 18,
    provisional: false,
  },
}

const lab: EngineLabSnapshot = {
  version: 2,
  date: '2026-08-21',
  generatedAt: 1,
  mode: 'shadow',
  cadence: 'daily',
  sleeves: [
    { key: 'short-horizon', label: '2–3 day direction', status: 'shadow', purpose: 'short read', evidenceN: 18, promotionRule: 'earn calibration' },
    { key: 'composite-control', label: 'Main engine', status: 'control', purpose: 'board', evidenceN: 144, promotionRule: 'control' },
  ],
  observations: [short],
}

const mount = () => render(
  <Router base="/app" hook={memoryLocation({ path: '/app/' }).hook}>
    <StrategyLabPanel lab={lab} />
  </Router>,
)

describe('StrategyLabPanel', () => {
  it('shows an honest first-run placeholder instead of hiding the new engine', () => {
    render(<StrategyLabPanel lab={null} />)
    expect(screen.getByLabelText('Research lab')).toHaveTextContent('No research ideas are available from the latest scan')
    expect(screen.getByLabelText('Forecast sleeves awaiting first run')).toHaveTextContent('Growing attention')
  })

  it('surfaces sleeve status and its independently matured evidence', () => {
    mount()
    const statuses = screen.getByLabelText('Strategy sleeve status')
    expect(within(statuses).getByText('Short-term direction')).toBeInTheDocument()
    expect(within(statuses).getByText('18 completed')).toBeInTheDocument()
    expect(within(statuses).getByText('144 completed')).toBeInTheDocument()
  })

  it('shows the forecast, reasons, risk, missing evidence and stock link', () => {
    mount()
    const panel = screen.getByLabelText('Research lab')
    expect(panel).toHaveTextContent(/Up\s*64%/)
    expect(panel).toHaveTextContent(/Down\s*29%/)
    expect(panel).toHaveTextContent(/Range\s*-1.2% to \+4.6%/)
    expect(panel).toHaveTextContent('similar historical states finished higher 7 times')
    expect(panel).toHaveTextContent('earnings are inside the forecast window')
    expect(panel).toHaveTextContent('social breadth not confirmed')
    expect(within(panel).getByRole('link')).toHaveAttribute('href', '/app/stock/GOOGL')
  })

  it('separates historical examples from live evidence and keeps research in shadow', () => {
    mount()
    const card = screen.getByRole('article', { name: 'GOOGL Short-term direction research' })
    expect(card).toHaveTextContent('18 similar past examples')
    expect(card).toHaveTextContent('0 completed saved forecasts')
    expect(card).toHaveTextContent('Being tested · no real trades')
    expect(card).toHaveTextContent(/Flat\s*7%/)
    expect(card).toHaveTextContent('Research rank 73/100')
  })

  it('exposes uncertainty and failed skill against the base rate', () => {
    render(<StrategyLabPanel symbol="GOOGL" observations={[{ ...short, forecast: {
      ...short.forecast, probabilityUpInterval: [0.4, 0.8], baselineProbabilityUp: 0.55,
      liveN: 42, brierScore: 0.3, brierSkillScore: -0.2,
    } }]} />)
    expect(screen.getByText(/Up frequency uncertainty/)).toHaveTextContent('40%–80%')
    expect(screen.getByText(/Live Brier error/)).toHaveTextContent('no improvement against the recorded base-rate forecast')
    expect(screen.getByText(/42 completed saved forecasts/)).toBeInTheDocument()
  })

  it('lets readers inspect a strategy without implying missing observations are loading', () => {
    mount()
    fireEvent.click(screen.getByRole('tab', { name: 'Recovery after a fall' }))
    expect(screen.getByText('No observations for this strategy in the latest scan.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'All strategies' }))
    expect(screen.getByRole('link')).toBeInTheDocument()
  })
})


describe('Research strategy interactions', () => {
  const recovery: StrategyObservation = {
    ...short, id: 'recovery:MSFT', sym: 'MSFT', sleeve: 'quality-dip',
    reasons: ['Cash generation remains strong after the selloff'], risks: ['Recovery is not confirmed'],
    metrics: { financialHealth: 'healthy', stabilising: false, worldTone: 'risk-off' },
    forecast: { ...short.forecast, definition: 'target-before-stop-v1', probabilityTarget: null, horizonSessions: 63, calibratedN: 0 },
  }
  it('moves focus and filters with arrow keys, Home and End', () => {
    render(<Router hook={memoryLocation().hook}><StrategyLabPanel lab={{ ...lab, observations: [short, recovery] }} /></Router>)
    const all = screen.getByRole('tab', { name: 'All strategies' })
    all.focus()
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    const direction = screen.getByRole('tab', { name: 'Short-term direction' })
    expect(direction).toHaveFocus()
    expect(direction).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('article', { name: /MSFT/ })).not.toBeInTheDocument()
    fireEvent.keyDown(direction, { key: 'ArrowRight' })
    const quality = screen.getByRole('tab', { name: 'Recovery after a fall' })
    expect(quality).toHaveFocus()
    expect(screen.getByRole('article', { name: /MSFT/ })).toHaveTextContent('Cash generation remains strong')
    expect(screen.queryByRole('article', { name: /GOOGL/ })).not.toBeInTheDocument()
    fireEvent.keyDown(quality, { key: 'End' })
    const social = screen.getByRole('tab', { name: 'Growing attention' })
    expect(social).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No observations for this strategy')
    fireEvent.keyDown(social, { key: 'Home' })
    expect(all).toHaveFocus()
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('keeps research rank distinct from probability and shows unknown calibration honestly', () => {
    render(<Router hook={memoryLocation().hook}><StrategyLabPanel observations={[recovery]} /></Router>)
    const card = screen.getByRole('article')
    expect(card).toHaveTextContent('Research rank 73/100')
    expect(card).toHaveTextContent('Chance of reaching the target before the loss limitNot enough results')
    expect(card).toHaveTextContent('0 completed ideas')
    expect(card).toHaveTextContent('Older scan')
    expect(card).toHaveTextContent('Not confirmed')
    expect(within(card).getByRole('link', { name: 'Open MSFT stock analysis' })).toHaveAttribute('href', '/stock/MSFT')
  })

  it('exposes forecast detail without nesting interactive controls in the stock link', () => {
    mount()
    const detail = screen.getByText('See the evidence').closest('details')!
    expect(detail).not.toHaveAttribute('open')
    expect(screen.getByText(/Research rank 73/)).not.toBeVisible()
    expect(screen.getByText('earnings are inside the forecast window')).toBeVisible()
    expect(detail.closest('a')).toBeNull()
    fireEvent.click(screen.getByText('See the evidence'))
    expect(detail).toHaveAttribute('open')
    expect(screen.getByText(/Research rank 73/)).toBeVisible()
  })
})


it('explains report-conditioned recovery estimates as retrospective research', () => {
  render(<StrategyLabPanel symbol="MSFT" observations={[{
    ...short, id: 'recovery-learned', sym: 'MSFT', sleeve: 'quality-dip',
    metrics: { reportTrend: 'improving', reportObservations: 5, reportLatestAvailableAt: 1_791_000_000 },
    forecast: { ...short.forecast, definition: 'target-before-stop-v1', calibrationBasis: 'validated-report-trend', conditioningStatus: 'validated', conditioningReason: 'The historical cohort reduced error against the pooled baseline.', conditioningContext: 'improving', conditioningN: 35, conditioningValidationN: 22 },
  }]} />)
  expect(screen.getByLabelText('Recovery evidence')).toHaveTextContent('Company report trendImproving · 5 reports')
  expect(screen.getByText(/Chronologically tested report-trend cohort/)).toHaveTextContent('reduced error against the pooled baseline')
  expect(screen.getByText(/This is retrospective evidence/)).not.toBeVisible()
  fireEvent.click(screen.getByText('See the evidence'))
  expect(screen.getByText(/This is retrospective evidence/)).toBeVisible()
  expect(screen.getByText(/22 chronological validation forecasts/)).toBeVisible()
  expect(screen.getByText('Being tested · no real trades')).toBeInTheDocument()
})


it('keeps a long cadence description out of the header while preserving it in methodology', () => {
  const cadence = 'Scans run after the daily market close, with observations held until their declared horizon is complete.'
  render(<Router hook={memoryLocation().hook}><StrategyLabPanel lab={{ ...lab, cadence }} /></Router>)
  const badge = screen.getByText('Being tested · updated daily')
  expect(badge.closest('.research-section-head')).not.toHaveTextContent(cadence)
  const methodology = screen.getByText('See the evidence: how ideas are tested').closest('details')!
  expect(methodology).toHaveTextContent(cadence)
  fireEvent.click(screen.getByText('See the evidence: how ideas are tested'))
  expect(screen.getByText(cadence, { exact: false })).toBeVisible()
  expect(screen.getByRole('tab', { name: 'Short-term direction' })).toBeInTheDocument()
  expect(screen.queryByText(/2–3 day/)).not.toBeInTheDocument()
})
