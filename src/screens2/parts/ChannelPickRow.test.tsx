// The shared pick row (The street page + Today's strip). Today.test.tsx already
// pins the STRIP's whole contract — the honesty rules, the grade law, the coin
// alias — through ChannelPicksStrip, and those tests now exercise this row
// underneath. What is tested here is only what the extraction ADDED: the
// detailed rendering The street page asks for, which the home screen must not
// grow by accident.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import type { ChannelPick } from '../../lib/apiViews'
import { ChannelPickRow, whoSaidIt } from './ChannelPickRow'

const mkPick = (o: Partial<ChannelPick> = {}): ChannelPick => ({
  sym: 'NVDA',
  mentions7d: 4,
  mentionsPrior7d: 2,
  channels: 3,
  bulls: 3,
  bears: 1,
  net: 2,
  crowded: false,
  shifted: false,
  ...o,
})

const withRouter = (ui: React.ReactNode) =>
  render(
    <Router base="/app" hook={memoryLocation({ path: '/app/more/street' }).hook}>
      {ui}
    </Router>,
  )

describe('whoSaidIt', () => {
  it('names everyone when the payload named everyone', () => {
    expect(whoSaidIt(['Josh', 'Gareth'], 2)).toBe('Josh, Gareth')
  })

  it('counts the unnamed tail off the two numbers the server actually sent', () => {
    expect(whoSaidIt(['Josh', 'Gareth'], 4)).toBe('Josh, Gareth + 2 more')
  })

  it('is null with no names — the caller falls back to the count it has always had', () => {
    expect(whoSaidIt(undefined, 3)).toBeNull()
    expect(whoSaidIt([], 3)).toBeNull()
    expect(whoSaidIt(['', '  '], 3)).toBeNull()
  })
})

describe('ChannelPickRow', () => {
  it('names the channels instead of counting them, on a detailed row', () => {
    withRouter(<ChannelPickRow pick={mkPick({ channels: 4, channelNames: ['Josh', 'Gareth'] })} row={undefined} open={undefined} detailed />)
    expect(screen.getByText(/from Josh, Gareth \+ 2 more/)).toBeInTheDocument()
    expect(screen.queryByText(/from 4 channels/)).not.toBeInTheDocument()
  })

  it('falls back to the count when a cached payload carries no names', () => {
    withRouter(<ChannelPickRow pick={mkPick({ channels: 4 })} row={undefined} open={undefined} detailed />)
    expect(screen.getByText(/from 4 channels/)).toBeInTheDocument()
  })

  it('calls out a stance that flipped against the prior week', () => {
    withRouter(<ChannelPickRow pick={mkPick({ shifted: true })} row={undefined} open={undefined} detailed />)
    expect(screen.getByText('stance flipped this week')).toHaveClass('pill', 'cp-shifted')
  })

  it('says nothing about a stance that held', () => {
    withRouter(<ChannelPickRow pick={mkPick({ shifted: false })} row={undefined} open={undefined} detailed />)
    expect(screen.queryByText(/flipped/)).not.toBeInTheDocument()
  })

  // the home screen's strip was ratified thin, and stays thin: the names and
  // the flip chip are The street page's, not Today's
  it('keeps the undetailed row exactly as the home screen has it', () => {
    withRouter(<ChannelPickRow pick={mkPick({ channels: 4, channelNames: ['Josh', 'Gareth'], shifted: true })} row={undefined} open={undefined} />)
    expect(screen.getByText(/from 4 channels/)).toBeInTheDocument()
    expect(screen.queryByText('Josh, Gareth + 2 more')).not.toBeInTheDocument()
    expect(screen.queryByText(/flipped/)).not.toBeInTheDocument()
  })
})
