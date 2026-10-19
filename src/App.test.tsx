import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { getToken } from './lib/api'

vi.mock('./lib/api', () => ({
  getToken: vi.fn(() => null), validateAccess: vi.fn(async () => true), clearToken: vi.fn(),
  setToken: vi.fn(), startTrial: vi.fn(async () => undefined),
}))
vi.mock('./lib/sync', () => ({ syncFromServer: vi.fn(async () => false) }))
vi.mock('./lib/starter', () => ({ seedStarterWatchlist: vi.fn(async () => false) }))
vi.mock('./lib/platform', () => ({ isDesktopShell: () => false }))
vi.mock('./shell/AppShell', () => ({ default: () => <h1>Product shell</h1> }))

beforeEach(() => {
  history.replaceState(null, '', '/')
  vi.mocked(getToken).mockReturnValue(null)
})

describe('public surface loads independently of product startup', () => {
  it.each([
    ['/engine', 'A signal engine that has to earn every call.'],
    ['/paper', 'A market paper written by an engine, edited by its own ledger.'],
    ['/ledger', 'Every call is graded in public — including the ones that were wrong.'],
    ['/faq', 'Straight answers, in writing.'],
  ])('resolves the lazy public page at %s', async (path, title) => {
    history.replaceState(null, '', path)
    render(<App />)
    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Product shell' })).toBeNull()
  })

  it('keeps licensed visitors on the public site until they choose the app', async () => {
    vi.mocked(getToken).mockReturnValue('licensed')
    render(<App />)
    const actions = await screen.findAllByRole('button', { name: /open (the )?app/i })
    expect(screen.queryByRole('heading', { name: 'Product shell' })).toBeNull()
    fireEvent.click(actions[0])
    expect(await screen.findByRole('heading', { name: 'Product shell' })).toBeInTheDocument()
    expect(location.pathname).toBe('/app/')
  })

  it('opens a licensed product visit directly without rendering the public surface', () => {
    vi.mocked(getToken).mockReturnValue('licensed')
    history.replaceState(null, '', '/app/')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Product shell' })).toBeInTheDocument()
    expect(screen.queryByText('Loading StreetSignal…')).toBeNull()
  })
})
