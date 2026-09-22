import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChunkRecoveryBoundary, isChunkLoadError } from './ChunkRecoveryBoundary'

describe('ChunkRecoveryBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('recognises the dynamic-import failure browsers report after a PWA deployment', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/Paper2-old.js'))).toBe(true)
    expect(isChunkLoadError(new Error('ordinary render failure'))).toBe(false)
  })

  it('keeps a stale lazy route from blanking the whole app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const StaleRoute = () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/Paper2-old.js')
    }
    render(
      <ChunkRecoveryBoundary>
        <StaleRoute />
      </ChunkRecoveryBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/app update ready/i)
    expect(screen.getByRole('button', { name: /update and reload/i })).toBeInTheDocument()
  })
})
