import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

vi.mock('../lib/db', () => ({
  db: { settings: { put: vi.fn() } },
  getCapital: () => Promise.resolve(5000),
  getChannels: () => Promise.resolve([{ id: 'UC123', name: 'Test Channel' }]),
}))
vi.mock('../lib/api', () => ({
  setToken: vi.fn(),
  resolveChannel: vi.fn(),
  getLicences: () => Promise.reject(new Error('401')), // non-admin device
  createLicence: vi.fn(),
  revokeLicence: vi.fn(),
  getLlmKeyStatus: () => Promise.resolve({ hasKey: false }),
  putLlmKey: vi.fn(),
  getT212KeyStatus: () => Promise.resolve({ connected: false, source: null }),
  putT212Key: vi.fn(),
  deleteT212Key: vi.fn(),
  apiGet: vi.fn(() => Promise.resolve(null)),
  putConfig: vi.fn(),
}))
vi.mock('../lib/configMirror', () => ({ mirrorConfig: vi.fn() }))
vi.mock('../lib/push', () => ({ enablePush: vi.fn(), pushSupported: () => false }))
// module-level window listener in the real module races across parallel jsdom envs
vi.mock('../lib/installPrompt', () => ({ onInstallAvailable: (fn: (a: boolean) => void) => { fn(false); return () => {} }, promptInstall: vi.fn() }))

import { SettingsScreen } from './SettingsScreen'

describe('SettingsScreen', () => {
  it('renders the grouped menu; non-admin devices get the AI group and the admin unlock row', async () => {
    const r = render(<SettingsScreen onBack={() => {}} />)
    expect(r.getByText('Appearance')).toBeInTheDocument()
    expect(r.getByText('Notifications')).toBeInTheDocument()
    expect(r.getByText('Trading')).toBeInTheDocument()
    expect(r.getByText('Open website in browser')).toBeInTheDocument()
    // admin probe rejects → unlock row + BYO-AI-key section appear
    await waitFor(() => expect(r.getByText('Unlock admin')).toBeInTheDocument())
    expect(r.getByText('Your AI key')).toBeInTheDocument()
    await waitFor(() => expect(r.getByText('Test Channel')).toBeInTheDocument())
  })
})
