import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {AppGate} from './AppGate'

beforeEach(()=>{localStorage.clear();vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200})))})
afterEach(()=>vi.unstubAllGlobals())
describe('free access recovery',()=>{
  it('offers retry without requiring a licence or a trial',()=>{
    const retry=vi.fn()
    render(<AppGate onUnlocked={()=>{}} onRetry={retry} error="Connection unavailable"/>)
    expect(screen.getByText('Free access. No sign-up or licence key needed.')).toBeInTheDocument()
    expect(screen.queryByText(/7-day/)).toBeNull()
    fireEvent.click(screen.getByText('Try again'));expect(retry).toHaveBeenCalledOnce()
  })
  it('validates an optional old key before replacing the current credential',async()=>{
    const unlocked=vi.fn();render(<AppGate onUnlocked={unlocked}/>)
    fireEvent.change(screen.getByLabelText('Licence key'),{target:{value:' https://example.com/?key=mb_reader '}})
    fireEvent.click(screen.getByText('Restore access'))
    expect(localStorage.getItem('mb-token')).toBeNull()
    await waitFor(()=>expect(unlocked).toHaveBeenCalledOnce())
    expect(localStorage.getItem('mb-token')).toBe('mb_reader')
  })
  it('keeps existing access if an invalid owner/reader key is entered',async()=>{
    localStorage.setItem('mb-token','current-access')
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:401})))
    const unlocked=vi.fn();render(<AppGate onUnlocked={unlocked}/>)
    fireEvent.change(screen.getByLabelText('Licence key'),{target:{value:'wrong-key'}})
    fireEvent.click(screen.getByText('Restore access'))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer valid')
    expect(localStorage.getItem('mb-token')).toBe('current-access');expect(unlocked).not.toHaveBeenCalled()
  })
})
