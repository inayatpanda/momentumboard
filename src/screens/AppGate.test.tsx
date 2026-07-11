import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AppGate } from './AppGate'

describe('AppGate — the app surface never shows the marketing site', () => {
  beforeEach(() => localStorage.clear())

  it('a pasted licence key unlocks: token stored, grace stamp set, onUnlocked fired', () => {
    const onUnlocked = vi.fn()
    render(<AppGate onUnlocked={onUnlocked} />)
    fireEvent.change(screen.getByLabelText('Licence key'), { target: { value: '  mb_abc123  ' } })
    fireEvent.click(screen.getByText('Unlock'))
    expect(localStorage.getItem('mb-token')).toBe('mb_abc123')
    expect(Number(localStorage.getItem('mb-token-at'))).toBeGreaterThan(0) // fresh-unlock grace armed
    expect(onUnlocked).toHaveBeenCalledOnce()
  })

  it('a whole pasted unlock LINK works too — the key is extracted', () => {
    const onUnlocked = vi.fn()
    render(<AppGate onUnlocked={onUnlocked} />)
    fireEvent.change(screen.getByLabelText('Licence key'), {
      target: { value: 'https://thestreetsignal.rqai.co.uk/?key=mb_deadbeef' },
    })
    fireEvent.click(screen.getByText('Unlock'))
    expect(localStorage.getItem('mb-token')).toBe('mb_deadbeef')
    expect(onUnlocked).toHaveBeenCalledOnce()
  })

  it('empty input cannot unlock', () => {
    const onUnlocked = vi.fn()
    render(<AppGate onUnlocked={onUnlocked} />)
    expect((screen.getByText('Unlock') as HTMLButtonElement).disabled).toBe(true)
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('offers the trial and the website link, but renders none of the marketing page', () => {
    render(<AppGate onUnlocked={() => {}} />)
    expect(screen.getByText('Start a free 7-day reader pass')).toBeInTheDocument()
    expect(screen.getByText('About The Street Signal ↗')).toHaveAttribute('href', 'https://thestreetsignal.rqai.co.uk/')
    expect(screen.queryByText(/What lands on the page/i)).toBeNull() // the site's feature grid stays on the site
  })
})
