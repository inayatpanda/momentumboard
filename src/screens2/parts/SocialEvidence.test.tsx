import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimEvidence, ProcessingJobs, SocialLearning } from './SocialEvidence'
import type { StreetVideo } from '../../lib/api'
import { parseSocialClaims } from '../../../shared/socialEvidence'
const retry = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api', async () => ({ ...await vi.importActual('../../lib/api'), retrySocialJob: retry }))
const quote = 'Tesla is bullish for the next year.'
const video: StreetVideo = { url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Sample', channel: 'Example', at: 100, tickers: [], themes: [], claims: parseSocialClaims([{ sym: 'TSLA', company: 'Tesla', stance: 'bull', evidenceQuote: quote, condition: null }], quote, [{ text: quote, startSec: 64, endSec: 70 }], 'video'), coverage: { complete: true, chunks: 2, analysedChunks: 2, textChars: 25000, totalSegments: 1, timedSegments: 1, visual: 'not-reviewed', language: 'en' } }

describe('visible social evidence', () => {
  it('shows actual source timecodes, reading coverage, and unknown factual verification', () => {
    render(<ClaimEvidence video={video} />)
    expect(screen.getByText('2/2 transcript sections read')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Quote matched'))
    expect(screen.getByRole('link', { name: 'Play source at 1:04 ↗' })).toHaveAttribute('href', video.url + '&t=64s')
    expect(screen.getByText('Not independently verified')).toBeVisible()
    expect(screen.getByText('Spoken words analysed. Charts have not been checked.')).toBeVisible()
  })
  it('has no invented video link when timing or source identity is missing', () => {
    render(<ClaimEvidence video={{ ...video, claims: [{ ...video.claims![0], startSec: undefined, endSec: undefined, sourceMatch: 'visual-unchecked' }] }} />)
    expect(screen.queryByRole('link', { name: /Play source/ })).not.toBeInTheDocument()
    expect(screen.getByText('Needs source check')).toBeInTheDocument()
  })
  it('does not present cold or repeated observations as an accuracy percentage', () => {
    render(<SocialLearning learning={{ version: 'v1', mode: 'shadow', pending: 8, completed: 0, independent: 0, repeats: 3, channels: [], recent: [] }} />)
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText(/does not change position sizes or channel weights/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
  it('allows an owner retry and reports permission failure rather than claiming success', async () => {
    retry.mockRejectedValueOnce(new Error('Owner access is required to retry processing.'))
    render(<ProcessingJobs health={{ pendingTranscripts: 1, queued: 0, deferred: 0, failed: 1, lastTranscriptAt: null, lastExtractAt: null, nextRetryAt: null, recentFailures: [], workerStale: true, jobs: [{ id: 'job', url: video.url, title: 'Pending example', mode: 'extract', stage: 'needs-attention', at: 100, attempts: 6, nextAttemptAt: 0 }] }} />)
    fireEvent.click(screen.getByText('Follow individual videos (1 shown)'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry (owner)' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Owner access is required')
    expect(retry).toHaveBeenCalledWith('job')
  })
})
