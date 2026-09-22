import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppGate } from './AppGate'

describe('AppGate — shared friends-preview password', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('validates the password server-side before storing and unlocking', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { level: 'user' } }), { status: 200 }))
    const onUnlocked = vi.fn()
    render(<AppGate onUnlocked={onUnlocked} />)
    fireEvent.change(screen.getByLabelText('Shared password'), { target: { value: '  millionaireclub  ' } })
    fireEvent.click(screen.getByText('Enter'))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledWith('/api/licences?check=1', { headers: { 'x-app-token': 'millionaireclub' } })
    expect(localStorage.getItem('mb-token')).toBe('millionaireclub')
  })

  it('does not store an incorrect password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    const onUnlocked = vi.fn()
    render(<AppGate onUnlocked={onUnlocked} />)
    fireEvent.change(screen.getByLabelText('Shared password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('Enter'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password')
    expect(localStorage.getItem('mb-token')).toBeNull()
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('offers no trial or individual licence flow', () => {
    render(<AppGate onUnlocked={() => {}} />)
    expect(screen.queryByText(/7-day reader pass/i)).toBeNull()
    expect(screen.queryByText(/licence key/i)).toBeNull()
    expect(screen.getByText('About The Street Signal ↗')).toHaveAttribute('href', 'https://thestreetsignal.rqai.co.uk/')
  })
})
