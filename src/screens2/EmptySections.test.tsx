import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import Intel from './Intel'
import Research from './Research2'
import Paper from './Paper2'
import Record from './Record'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, ...Object.fromEntries(['getNewsDesk','getInsiderClusters','getCongress','getSocialPulse','getAiRead','getEventDossiers','getPicks','getPickStats','getOutcomes','getReportJson'].map(k => [k, vi.fn(() => Promise.reject(new Error('http-503')))])) }
})
vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return { ...actual, getLearning: vi.fn(() => Promise.reject(new Error('http-503'))), getLedgerDays: vi.fn(() => Promise.reject(new Error('http-503'))), getPaperBook: vi.fn(() => Promise.reject(new Error('http-503'))) }
})
const show = (element: React.ReactNode) => render(<Router base="/app" hook={memoryLocation({path:'/app/'}).hook}>{element}</Router>)
beforeEach(async () => { await db.slices.clear(); vi.clearAllMocks() })
describe('remaining screens handle missing data', () => {
  it('retries one failed Intel feed without concealing the other feeds', async () => {
    const api = await import('../lib/api')
    await db.slices.put({ key:'intel:insiders', fetchedAt:Date.now(), data:{clusters:[{symbol:'NVDA',buyers:2,totalValueUsd:1000,lastDate:'2026-10-20',names:[]}]} })
    show(<Intel />)
    const failed = await screen.findByRole('alert', {name:'News unavailable'})
    expect(screen.getByText('NVDA')).toBeInTheDocument()
    vi.mocked(api.getNewsDesk).mockResolvedValueOnce([])
    fireEvent.click(within(failed).getByRole('button'))
    expect(await screen.findByText('Nothing fresh right now.')).toBeInTheDocument()
    expect(screen.queryByRole('alert',{name:'News unavailable'})).not.toBeInTheDocument()
  })
  it('shows research failures explicitly rather than indefinite loading', async () => {
    show(<Research />)
    expect(await screen.findByRole('alert',{name:'Event assessments unavailable'})).toBeInTheDocument()
    expect(await screen.findByRole('alert',{name:'Research scorecard unavailable'})).toBeInTheDocument()
    expect(screen.queryByText('Loading event assessments…')).not.toBeInTheDocument()
  })
  it('explains genuinely empty research datasets and links to available evidence', async () => {
    for (const [key, data] of [['research:events', []], ['research:picks', {persistence:[],reports:0}], ['research:pickStats', {scores:[]}], ['research:outcomes', []]] as const) await db.slices.put({key,data,fetchedAt:Date.now()})
    show(<Research />)
    expect(await screen.findByText(/No event assessments have been published/)).toBeInTheDocument()
    expect(await screen.findByRole('link',{name:'View Track record →'})).toHaveAttribute('href','/app/record')
    expect(await screen.findByRole('link',{name:'Open calendar →'})).toHaveAttribute('href','/app/more/calendar')
  })
  it('recovers a failed paper request through its retry button', async () => {
    const api = await import('../lib/api')
    show(<Paper />)
    const failed = await screen.findByRole('alert',{name:'Edition unavailable'})
    vi.mocked(api.getReportJson).mockResolvedValueOnce({date:'2026-10-20',at:1,html:'<h1>Recovered edition</h1>'})
    fireEvent.click(within(failed).getByRole('button'))
    expect(await screen.findByTitle("Today's paper")).toHaveAttribute('srcdoc','<h1>Recovered edition</h1>')
  })
  it('distinguishes unavailable record datasets from empty or zero performance', async () => {
    show(<Record />)
    for (const name of ['Track record','Published calls','Paper book']) expect(await screen.findByRole('alert',{name:`${name} unavailable`})).toBeInTheDocument()
    expect(screen.queryByText(/first run yet/)).not.toBeInTheDocument()
  })
})
