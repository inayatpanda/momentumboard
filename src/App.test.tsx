import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { getToken,validateAccess,provisionFreeAccess,reloadForAccess } from './lib/api'
import { syncFromServer } from './lib/sync'

vi.mock('./lib/api', () => ({
  getToken: vi.fn(() => null), validateAccess: vi.fn(async () => true), clearToken: vi.fn(),
  setToken: vi.fn(), startTrial: vi.fn(async () => undefined),
  provisionFreeAccess:vi.fn(async()=>({key:'device'})),reloadForAccess:vi.fn(),apiUrl:(path:string)=>path,
}))
vi.mock('./lib/sync', () => ({ syncFromServer: vi.fn(async () => false) }))
vi.mock('./lib/starter', () => ({ seedStarterWatchlist: vi.fn(async () => false) }))
vi.mock('./lib/platform', () => ({ isDesktopShell: () => false }))
vi.mock('./shell/AppShell', () => ({ default: () => <h1>Product shell</h1> }))

beforeEach(() => {
  vi.clearAllMocks()
  history.replaceState(null, '', '/')
  vi.mocked(getToken).mockReturnValue(null)
  vi.mocked(validateAccess).mockResolvedValue(true)
  vi.mocked(provisionFreeAccess).mockResolvedValue({key:'device'})
})

describe('public surface loads independently of product startup', () => {
  it.each([
    ['/engine', 'A clearer view of the evidence.'],
    ['/paper', 'Understand what changed, and why it matters.'],
    ['/ledger', 'Show the test, not just the claim.'],
    ['/faq', 'Straight answers.'],
  ])('resolves the lazy public page at %s', async (path, title) => {
    history.replaceState(null, '', path)
    render(<App />)
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Product shell' })).toBeNull()
  })

  it('keeps licensed visitors on the public site until they choose the app', async () => {
    vi.mocked(getToken).mockReturnValue('licensed')
    render(<App />)
    const actions = await screen.findAllByRole('link', { name: /open (the free )?app/i })
    expect(screen.queryByRole('heading', { name: 'Product shell' })).toBeNull()
    expect(actions[0]).toHaveAttribute('href','/app/')
    expect(provisionFreeAccess).not.toHaveBeenCalled()
    expect(syncFromServer).not.toHaveBeenCalled()
  })

  it('opens an existing product visit after checking its credential', async() => {
    vi.mocked(getToken).mockReturnValue('licensed')
    history.replaceState(null, '', '/app/')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Product shell' })).toBeInTheDocument()
    expect(screen.queryByText('Loading StreetSignal…')).toBeNull()
  })
  it('automatically provisions fresh visits without losing their stock deep link or syncing old local data',async()=>{
    history.replaceState(null,'','/app/stock/AAPL?view=evidence')
    render(<StrictMode><App/></StrictMode>)
    await waitFor(()=>expect(reloadForAccess).toHaveBeenCalledOnce())
    expect(location.pathname+location.search).toBe('/app/stock/AAPL?view=evidence')
    expect(syncFromServer).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Licence key')).toBeNull()
  })
  it('replaces an expired legacy trial only through a separate free identity before opening personal views',async()=>{
    vi.mocked(getToken).mockReturnValue('expired-trial');vi.mocked(validateAccess).mockResolvedValue(false)
    history.replaceState(null,'','/app/stocks?view=strategies');render(<App/>)
    await waitFor(()=>expect(provisionFreeAccess).toHaveBeenCalledOnce())
    expect(reloadForAccess).toHaveBeenCalledOnce();expect(syncFromServer).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading',{name:'Product shell'})).toBeNull()
  })
  it('shows retry on a provisioning failure and never enters the old personal workspace',async()=>{
    vi.mocked(provisionFreeAccess).mockRejectedValue(new Error('Free access is busy'))
    history.replaceState(null,'','/app/');render(<App/>)
    expect(await screen.findByRole('alert')).toHaveTextContent('Free access is busy')
    expect(screen.getByText('Try again')).toBeInTheDocument();expect(syncFromServer).not.toHaveBeenCalled()
  })
})
