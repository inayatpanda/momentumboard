// Settings v2 (plan Task 21). No useSlice/Dexie here — Settings reads the
// licence probe + BYOK/notifications/config rows straight off lib/api, same
// as the legacy screen, so these tests mock '../lib/api' directly (Board.
// test.tsx's importActual-merge pattern) rather than seeding a slice.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getLicences: vi.fn(),
    getLlmKeyStatus: vi.fn(() => Promise.resolve({ hasKey: false, llmKeySource: null })),
    apiGet: vi.fn(() => Promise.reject(new Error('not mocked'))),
  }
})

import { getLicences } from '../lib/api'

const asAdmin = () =>
  vi.mocked(getLicences).mockResolvedValue([{ key: 'admin-key-xxxxxxxx', label: 'Owner', createdAt: Date.now(), unlockLink: 'https://example.com/u/1' }])
const asNonAdmin = () => vi.mocked(getLicences).mockRejectedValue(new Error('unauthorised'))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Settings', () => {
  it('has a heading "Settings"', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })

  it('contains no literal "212" anywhere in its rendered output or its own source (owner decision D11)', async () => {
    asNonAdmin()
    const { container } = render(<Settings />)
    await waitFor(() => expect(screen.getByText('Licensed device')).toBeInTheDocument())
    expect(container.textContent).not.toMatch(/212/)

    // cwd-relative, not import.meta.url — jsdom serves modules from http://
    // and readFileSync needs file paths (same pattern as src/theme.test.ts)
    for (const file of [
      'src/screens2/Settings.tsx',
      'src/screens2/parts/SettingsAdmin.tsx',
      'src/screens2/parts/SettingsExtras.tsx',
      'src/screens2/parts/InstallRow.tsx',
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(src).not.toMatch(/212/)
    }
  })

  it('shows the admin-unlock row and hides the licence manager + BYOK key for a non-admin device', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByText('Unlock admin')).toBeInTheDocument()
    expect(screen.queryByText('Licences')).not.toBeInTheDocument()
    expect(screen.queryByText('Briefing recipients')).not.toBeInTheDocument()
    // BYOK is the inverse gate: non-admin devices DO see it
    expect(await screen.findByText('Your AI key')).toBeInTheDocument()
  })

  it('shows the licence manager + briefing recipients and hides admin-unlock + BYOK for an admin device', async () => {
    asAdmin()
    render(<Settings />)
    expect(await screen.findByText('Licences')).toBeInTheDocument()
    expect(screen.getByText('Briefing recipients')).toBeInTheDocument()
    expect(screen.queryByText('Unlock admin')).not.toBeInTheDocument()
    expect(screen.queryByText('Your AI key')).not.toBeInTheDocument()
  })

  it('offers no way back to the legacy shell — the escape hatch died with it', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByText('App')).toBeInTheDocument()
    expect(screen.queryByText('Classic shell')).not.toBeInTheDocument()
  })

  it('the theme row cycles auto → light → dark, writing mb-theme and dataset.theme each time', async () => {
    asNonAdmin()
    render(<Settings />)
    const group = await screen.findByText('Theme')
    const row = group.closest('.menu-row') as HTMLElement
    const lightBtn = within(row).getByRole('button', { name: 'Light' })
    lightBtn.click()
    await waitFor(() => expect(localStorage.getItem('mb-theme')).toBe('light'))
    expect(document.documentElement.dataset.theme).toBe('light')

    const darkBtn = within(row).getByRole('button', { name: 'Dark' })
    darkBtn.click()
    await waitFor(() => expect(localStorage.getItem('mb-theme')).toBe('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

// VISIBILITY WAVE (2026-08-17) — the live walkthrough watched /api/licences
// 401 three times on one Settings paint. The shared DMG token cannot be the
// admin key, so the answer was known before the request left: asking anyway is
// noise in the log, three red rows in the reader's devtools, and a "Checking
// licence…" flicker on a device with no licence to check.
describe('Settings on the shared free token', () => {
  const FREE = 'mb_freefreefreefreefreefreefreefreefre'

  beforeEach(() => {
    vi.stubEnv('VITE_FREE_TOKEN', FREE)
    localStorage.setItem('mb-token', FREE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('never asks the server about a licence it already knows the answer for', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByText('Free preview')).toBeInTheDocument()
    expect(getLicences).not.toHaveBeenCalled()
  })

  it('says what the free tier IS, and never quotes the shared key back as the reader’s own', async () => {
    asNonAdmin()
    render(<Settings />)
    const row = await screen.findByLabelText('Licence status')
    expect(within(row).getByText(/free preview — licence binding comes later/i)).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/ending …/)
    expect(row.textContent).not.toContain(FREE.slice(-6))
    // and it never flickers through the probe state it is not in
    expect(within(row).queryByText(/checking licence/i)).not.toBeInTheDocument()
  })

  it('is treated as a non-admin device — the unlock hatch stays, the manager does not', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByText('Unlock admin')).toBeInTheDocument()
    expect(screen.queryByText('Licences')).not.toBeInTheDocument()
  })

  it('a personal key on the same build still asks the server', async () => {
    localStorage.setItem('mb-token', 'mb_personal_key_9999')
    asNonAdmin()
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('Licensed device')).toBeInTheDocument())
    expect(getLicences).toHaveBeenCalled()
  })
})
