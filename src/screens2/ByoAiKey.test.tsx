// The BYOK row during the device-key transition.
//
// Two populations sit behind this one row: readers whose key is already in
// this browser profile's IndexedDB, and licensees whose key is still in the
// server blob this release is retiring. Only the second is asked to do
// anything, and what they are asked for is a RE-ENTRY — the server has no way
// to hand the key back, by design. These pin exactly that: who sees the
// notice, that nothing secret is fetched to show it, and that the server copy
// is deleted only once a device copy exists.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ByoAiKey, SERVER_KEY_NOTICE } from './parts/SettingsExtras'
import { clearDeviceGroqKey, getDeviceGroqKey } from '../lib/deviceLlm'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getLlmKeyStatus: vi.fn(),
    probeGroqKey: vi.fn(),
    deleteServerLlmKey: vi.fn(() => Promise.resolve()),
  }
})

import { deleteServerLlmKey, getLlmKeyStatus, probeGroqKey } from '../lib/api'

const GOOD_KEY = 'gsk_abcdefghijklmnopqrstuvwxyz123456'

const onServer = () => vi.mocked(getLlmKeyStatus).mockResolvedValue({ hasKey: true, llmKeySource: 'server' })
const onDevice = () => vi.mocked(getLlmKeyStatus).mockResolvedValue({ hasKey: true, llmKeySource: 'device' })
const noKey = () => vi.mocked(getLlmKeyStatus).mockResolvedValue({ hasKey: false, llmKeySource: null })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.clearAllMocks()
  await clearDeviceGroqKey()
  vi.mocked(probeGroqKey).mockResolvedValue({ provider: 'groq', model: 'openai/gpt-oss-120b' })
  vi.mocked(deleteServerLlmKey).mockResolvedValue(undefined)
  fetchMock = vi.fn(() => Promise.reject(new Error('no network in this test')))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ByoAiKey — the migration notice', () => {
  it('appears for a licensee whose key is still on the server', async () => {
    onServer()
    render(<ByoAiKey isAdmin={false} />)
    expect(await screen.findByText(`${SERVER_KEY_NOTICE}.`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /move it here/i })).toBeInTheDocument()
  })

  it('does NOT appear once the key lives on this device', async () => {
    onDevice()
    render(<ByoAiKey isAdmin={false} />)
    expect(await screen.findByText(/a key is saved on this device/i)).toBeInTheDocument()
    expect(screen.queryByText(`${SERVER_KEY_NOTICE}.`)).not.toBeInTheDocument()
  })

  it('does NOT appear for a reader with no key anywhere', async () => {
    noKey()
    render(<ByoAiKey isAdmin={false} />)
    expect(await screen.findByText(/no key saved yet/i)).toBeInTheDocument()
    expect(screen.queryByText(`${SERVER_KEY_NOTICE}.`)).not.toBeInTheDocument()
  })

  it('the notice button fetches nothing — it only puts the cursor in the field', async () => {
    onServer()
    render(<ByoAiKey isAdmin={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /move it here/i }))
    expect(screen.getByLabelText('Groq API key')).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled() // the key is never handed back
  })

  it('the whole row stays hidden on an admin device (the inverse gate is unchanged)', async () => {
    onServer()
    let container!: HTMLElement
    await act(async () => {
      container = render(<ByoAiKey isAdmin={true} />).container
      render(<ByoAiKey isAdmin={null} />) // still probing — nothing yet
    })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Your AI key')).not.toBeInTheDocument()
  })
})

describe('ByoAiKey — save & test', () => {
  const typeKey = (value = GOOD_KEY) => fireEvent.change(screen.getByLabelText('Groq API key'), { target: { value } })

  it('probes the key, stores it on the device, THEN clears the server copy — and the notice goes', async () => {
    onServer()
    render(<ByoAiKey isAdmin={false} />)
    await screen.findByText(`${SERVER_KEY_NOTICE}.`)
    typeKey()
    fireEvent.click(screen.getByRole('button', { name: /save & test/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /connected/i })).toBeInTheDocument())
    expect(probeGroqKey).toHaveBeenCalledWith(GOOD_KEY)
    expect(await getDeviceGroqKey()).toBe(GOOD_KEY)
    expect(deleteServerLlmKey).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(`${SERVER_KEY_NOTICE}.`)).not.toBeInTheDocument()
  })

  it('a key Groq rejects is stored NOWHERE and the server copy survives', async () => {
    onServer()
    vi.mocked(probeGroqKey).mockRejectedValue(new Error('groq 401 invalid_api_key'))
    render(<ByoAiKey isAdmin={false} />)
    await screen.findByText(`${SERVER_KEY_NOTICE}.`)
    typeKey()
    fireEvent.click(screen.getByRole('button', { name: /save & test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was saved/i)
    expect(await getDeviceGroqKey()).toBeNull()
    expect(deleteServerLlmKey).not.toHaveBeenCalled()
    expect(screen.getByText(`${SERVER_KEY_NOTICE}.`)).toBeInTheDocument()
  })

  it('a string that is not a Groq key at all is named as such', async () => {
    noKey()
    render(<ByoAiKey isAdmin={false} />)
    await screen.findByText(/no key saved yet/i)
    typeKey('hunter2')
    fireEvent.click(screen.getByRole('button', { name: /save & test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like a groq key/i)
    expect(await getDeviceGroqKey()).toBeNull()
  })

  it('the save button is dead until something is typed', async () => {
    noKey()
    render(<ByoAiKey isAdmin={false} />)
    const btn = await screen.findByRole('button', { name: /save & test/i })
    expect(btn).toBeDisabled()
    typeKey()
    expect(btn).not.toBeDisabled()
  })

  it('disconnecting drops the device key and the server copy together', async () => {
    onDevice()
    render(<ByoAiKey isAdmin={false} />)
    fireEvent.click(await screen.findByLabelText('Disconnect Groq'))
    await waitFor(() => expect(screen.getByText(/no key saved yet/i)).toBeInTheDocument())
    expect(await getDeviceGroqKey()).toBeNull()
    expect(deleteServerLlmKey).toHaveBeenCalledTimes(1)
  })

  it('never offers a way to read a stored key back', async () => {
    onServer()
    const { container } = render(<ByoAiKey isAdmin={false} />)
    await screen.findByText(`${SERVER_KEY_NOTICE}.`)
    expect((screen.getByLabelText('Groq API key') as HTMLInputElement).value).toBe('')
    expect(container.textContent).not.toMatch(/gsk_/)
  })
})
