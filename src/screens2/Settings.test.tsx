// Settings v2. Reader access is handled once by the shared-password gate;
// Settings itself contains no licence UI. The owner probe remains internal so
// owner-only briefing recipients do not appear for friends.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getLicences: vi.fn(),
    getLlmKeyStatus: vi.fn(() => Promise.resolve({ hasKey: false })),
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
    await screen.findByText('Your AI key')
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

  it('shows device-local Groq controls and no licence controls for a friend device', async () => {
    asNonAdmin()
    render(<Settings />)
    expect(await screen.findByText('Your AI key')).toBeInTheDocument()
    expect(screen.getByLabelText('Groq API key')).toBeInTheDocument()
    expect(screen.queryByText('Licences')).not.toBeInTheDocument()
    expect(screen.queryByText('Unlock admin')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Licence status')).not.toBeInTheDocument()
    expect(screen.queryByText('Briefing recipients')).not.toBeInTheDocument()
  })

  it('shows briefing recipients but no licence manager or BYOK for the owner', async () => {
    asAdmin()
    render(<Settings />)
    expect(await screen.findByText('Briefing recipients')).toBeInTheDocument()
    expect(screen.queryByText('Licences')).not.toBeInTheDocument()
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

describe('Settings access model', () => {
  it('never renders the retired licence, trial, or free-tier language', async () => {
    asNonAdmin()
    const { container } = render(<Settings />)
    await screen.findByText('Your AI key')
    expect(container.textContent).not.toMatch(/licen[cs]e|trial|free preview/i)
  })
})
