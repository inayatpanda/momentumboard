import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PULL_THRESHOLD } from '../../lib/usePullRefresh'
import { RefreshStrip } from './RefreshStrip'

describe('RefreshStrip', () => {
  it('renders no bar at rest — an idle screen shows no chrome', () => {
    render(<RefreshStrip refreshing={false} onRefresh={() => {}} />)
    expect(document.querySelector('.rf-bar')).toBeNull()
  })

  it('fills with the gesture, and marks the bar armed at the threshold', () => {
    const { rerender } = render(<RefreshStrip refreshing={false} pull={PULL_THRESHOLD / 2} onRefresh={() => {}} />)
    const bar = document.querySelector('.rf-bar-pull') as HTMLElement
    expect(bar.style.transform).toBe('scaleX(0.5)')
    expect(bar.hasAttribute('data-armed')).toBe(false)
    rerender(<RefreshStrip refreshing={false} pull={PULL_THRESHOLD + 40} onRefresh={() => {}} />)
    expect((document.querySelector('.rf-bar-pull') as HTMLElement).hasAttribute('data-armed')).toBe(true)
  })

  it('a fetch in flight is an announced status, not a pull bar', () => {
    render(<RefreshStrip refreshing pull={PULL_THRESHOLD} onRefresh={() => {}} />)
    expect(screen.getByRole('status', { name: /refreshing/i })).toBeInTheDocument()
    expect(document.querySelector('.rf-bar-pull')).toBeNull()
  })

  it('the desk button refreshes, and is disabled while one is already running', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<RefreshStrip refreshing={false} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<RefreshStrip refreshing onRefresh={onRefresh} />)
    expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled()
  })
})
