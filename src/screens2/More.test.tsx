// More (plan Task 21) — the grouped menu behind the More tab: engine /
// reading / app groups, and the theme cycle row (lib/theme.ts). Navigation
// is exercised through a tiny local Switch (same shape as AppShell's real
// route table, scoped to just the destinations this menu links to) rather
// than the full AppShell — More itself owns no data fetch.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { Route, Router, Switch } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import More from './More'

function Harness({ path }: { path: string }) {
  const { hook } = memoryLocation({ path, record: true })
  return (
    <Router base="/app" hook={hook}>
      <Switch>
        <Route path="/more" component={More} />
        <Route path="/more/gates">
          <h1>Gates stub</h1>
        </Route>
        <Route path="/more/street">
          <h1>Street stub</h1>
        </Route>
        <Route path="/more/research">
          <h1>Research stub</h1>
        </Route>
        <Route path="/more/calendar">
          <h1>Calendar stub</h1>
        </Route>
        <Route path="/settings">
          <h1>Settings stub</h1>
        </Route>
      </Switch>
    </Router>
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.theme = ''
})

describe('More', () => {
  it('has a heading "More" and the three grouped rows', () => {
    render(<Harness path="/app/more" />)
    expect(screen.getByRole('heading', { name: 'More' })).toBeInTheDocument()
    expect(screen.getByText('The engine')).toBeInTheDocument()
    expect(screen.getByText('Reading')).toBeInTheDocument()
    expect(screen.getByText('App')).toBeInTheDocument()
    expect(screen.getByText('Gates & learning')).toBeInTheDocument()
    expect(screen.getByText('The street')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('Calendar')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  // Owner (2026-08-17, with a screenshot): "Gates & learning is present twice,
  // outside and inside More." Nothing may be listed twice on one screen: the
  // Reading group holds exactly the rail-promoted pages, so at rail widths CSS
  // hides that whole group (jsdom applies no stylesheet — the class the media
  // query keys on IS the honest assertion, same form as rail-only's).
  it('marks the Reading group on-rail so the rail widths hide the duplicate listings', () => {
    render(<Harness path="/app/more" />)
    const reading = screen.getByText('Reading').closest('.menu-group')!
    expect(reading).toHaveClass('on-rail')
    // The street joined that group (owner 2026-08-17) the same way the others
    // did. Gates & learning is DEMOTED from the rail — More is its only home,
    // so its group must stay visible at every width; App likewise
    expect(screen.getByText('The engine').closest('.menu-group')!).not.toHaveClass('on-rail')
    expect(screen.getByText('App').closest('.menu-group')!).not.toHaveClass('on-rail')
  })

  it('navigates to Gates & learning, Research, Calendar and Settings', () => {
    render(<Harness path="/app/more" />)
    fireEvent.click(screen.getByText('Gates & learning'))
    expect(screen.getByRole('heading', { name: 'Gates stub' })).toBeInTheDocument()
  })

  it('navigates to The street', () => {
    render(<Harness path="/app/more" />)
    fireEvent.click(screen.getByText('The street'))
    expect(screen.getByRole('heading', { name: 'Street stub' })).toBeInTheDocument()
  })

  it('navigates to Research', () => {
    render(<Harness path="/app/more" />)
    fireEvent.click(screen.getByText('Research'))
    expect(screen.getByRole('heading', { name: 'Research stub' })).toBeInTheDocument()
  })

  it('navigates to Calendar', () => {
    render(<Harness path="/app/more" />)
    fireEvent.click(screen.getByText('Calendar'))
    expect(screen.getByRole('heading', { name: 'Calendar stub' })).toBeInTheDocument()
  })

  it('navigates to Settings', () => {
    render(<Harness path="/app/more" />)
    fireEvent.click(screen.getByText('Settings'))
    expect(screen.getByRole('heading', { name: 'Settings stub' })).toBeInTheDocument()
  })

  describe('theme row', () => {
    it('cycles auto → dark → light → auto, writing mb-theme and dataset.theme each tap', () => {
      render(<Harness path="/app/more" />)
      const row = screen.getByText('Theme').closest('button') as HTMLElement
      expect(row).toHaveTextContent('Auto')

      fireEvent.click(row)
      expect(localStorage.getItem('mb-theme')).toBe('dark')
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(row).toHaveTextContent('Dark')

      fireEvent.click(row)
      expect(localStorage.getItem('mb-theme')).toBe('light')
      expect(document.documentElement.dataset.theme).toBe('light')
      expect(row).toHaveTextContent('Light')

      fireEvent.click(row)
      expect(localStorage.getItem('mb-theme')).toBe('auto')
      expect(row).toHaveTextContent('Auto')
    })
  })

  it('hides the install row when the browser has not offered beforeinstallprompt', () => {
    render(<Harness path="/app/more" />)
    expect(screen.queryByText('Install the app')).not.toBeInTheDocument()
  })
})
