// Settings v2 (plan Task 21). No useSlice/Dexie here — Settings reads the
// licence probe + BYOK/notifications/config rows straight off lib/api, same
// as the legacy screen, so these tests mock '../lib/api' directly (Board.
// test.tsx's importActual-merge pattern) rather than seeding a slice.

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
