import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import DeskLayout from './DeskLayout'

vi.mock('../screens2/parts/BoardColumn', () => ({
  default: () => { throw new TypeError('Failed to fetch dynamically imported module: /assets/BoardColumn-old.js') },
}))

afterEach(() => vi.restoreAllMocks())

it('keeps navigation and the stock page visible when an old desktop board chunk cannot load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<Router hook={memoryLocation({ path: '/stock/AAPL' }).hook}>
    <DeskLayout><h1>Apple Inc.</h1></DeskLayout>
  </Router>)
  expect(await screen.findByRole('button', { name: /update and reload/i })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Apple Inc.' })).toBeVisible()
  expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
})
