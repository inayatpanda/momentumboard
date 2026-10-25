import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EnginePage, FaqPage, LedgerPage, PaperPage, PrivacyPage, siteRouteFor } from './SitePages'
import { Landing } from './Landing'
import PublicSite from './PublicSite'

const textOf=(element:HTMLElement)=>element.textContent!.replace(/\s+/g,' ')
afterEach(()=>window.history.replaceState({},'','/'))

describe('free public website',()=>{
  it('offers direct app access without starting a trial, asking for a key or promoting desktop downloads',()=>{
    const unlock=vi.fn()
    const {container}=render(<Landing onUnlocked={unlock}/>)
    expect(screen.getByRole('link',{name:'Open the free app'})).toHaveAttribute('href','/app/')
    expect(screen.getByRole('link',{name:'Start exploring'})).toHaveAttribute('href','/app/')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('a[href^="/download"]')).toBeNull()
    expect(unlock).not.toHaveBeenCalled()
    expect(textOf(container)).toContain('No signup. No payment details. No access key to enter.')
    expect(textOf(container)).not.toMatch(/7.day|licence-only|calibrated calls|free forever/i)
    expect(screen.getAllByRole('heading',{level:1})).toHaveLength(1)
  })
  it('explains the two research paths without implying automatic or proven trades',()=>{
    const {container}=render(<Landing licensed onUnlocked={()=>{}}/>)
    const paths=screen.getByLabelText('Two ways to use StreetSignal')
    expect(within(paths).getByRole('heading',{name:'Buy ideas'})).toBeVisible()
    expect(within(paths).getByRole('heading',{name:'Review selling'})).toBeVisible()
    expect(paths).toHaveTextContent('the app does not place trades')
    expect(textOf(container)).toContain('250 stocks')
    expect(textOf(container)).toContain('your Mac can be switched off')
    expect(textOf(container)).toContain('Some optional personal AI tools need your own provider key')
  })
  it.each([EnginePage,PaperPage,LedgerPage,FaqPage,PrivacyPage])('keeps public detail pages open and their calls to action real',Page=>{
    const {container}=render(<Page/>)
    expect(screen.getByRole('link',{name:'Open the free app'})).toHaveAttribute('href','/app/')
    expect(screen.getAllByRole('heading',{level:1})).toHaveLength(1)
    expect(container.querySelector('a[href="/#access"]')).toBeNull()
    expect(textOf(container)).not.toMatch(/7.day reader|licence.only|start free.*7 days|calibrated analysis|real installers/i)
    expect(within(screen.getByRole('navigation',{name:'Footer'})).getByRole('link',{name:'Privacy'})).toHaveAttribute('href','/privacy')
  })
  it('describes independent evidence, sell-review limits and honest empty screens',()=>{
    const {container}=render(<EnginePage/>)
    const text=textOf(container)
    expect(text).toContain('Each approach keeps its own rules, stock choices and historical results')
    expect(text).toContain('missing company information')
    expect(text).toContain('businesses that need specialist review')
    expect(text).toContain('A price warning does not prove that a business is getting worse')
    expect(text).toContain('A review flag is not an instruction to sell')
    expect(text).not.toMatch(/makes calibrated calls|full-size trade|trades at half size/)
  })
  it('keeps historical simulations, live forecasts and unvalidated sell warnings distinct',()=>{
    const {container}=render(<LedgerPage/>)
    const text=textOf(container)
    expect(text).toContain('live research universe and historical test sample can differ')
    expect(text).toContain('Historical simulations replay rules on past data')
    expect(text).toContain('Saved forecasts can be checked after their stated time has passed')
    expect(text).toContain('they are not validated forecasts of a future decline')
  })
  it('answers the cost and cloud questions while disclosing YouTube gaps',()=>{
    render(<FaqPage/>)
    const free=screen.getByText('Is StreetSignal free?')
    fireEvent.click(free)
    expect(free.closest('details')).toHaveTextContent('Optional personal AI tools may need your own provider key')
    fireEvent.click(screen.getByText('Are all YouTube videos covered?'))
    expect(screen.getByText(/Research focuses on selected channels/)).toBeVisible()
    expect(screen.getByText(/Research focuses on selected channels/)).toHaveTextContent('available free processing capacity')
  })
  it('states local and server storage honestly without promising deletion or private operator access',()=>{
    const {container}=render(<PrivacyPage/>)
    const text=textOf(container)
    expect(text).toContain('random access ID for this browser profile')
    expect(text).toContain('different browser or device starts with different access')
    expect(text).toContain('The server operator can access it')
    expect(text).toContain('Clearing your browser does not automatically delete data already copied to the server')
    expect(text).toContain('New keys are stored in this browser and excluded from backups')
    expect(text).toContain('the key and relevant prompt or content pass through the app’s server to the provider')
    expect(text).toContain('Older installations may still have a previously saved AI key on the server')
    expect(text).not.toMatch(/we never store|we cannot access|automatically deleted|contact.*@/i)
  })
})

describe('public routing',()=>{
  it.each(['engine','paper','ledger','faq','privacy'] as const)('maps /%s with an optional trailing slash',page=>{
    expect(siteRouteFor(`/${page}`)).toBe(page)
    expect(siteRouteFor(`/${page}/`)).toBe(page)
  })
  it('does not mistake a similar path for a known page',()=>{
    expect(siteRouteFor('/engine-private')).toBe('home')
    expect(siteRouteFor('/anything-else')).toBe('home')
  })
  it('renders the privacy page at its real public URL',()=>{
    window.history.replaceState({},'','/privacy')
    render(<PublicSite licensed={false} onUnlocked={()=>{}}/>)
    expect(screen.getByRole('heading',{level:1})).toHaveTextContent('Your data, in plain language.')
  })
})
