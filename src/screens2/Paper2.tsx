// The paper — its own page (owner 2026-08-17: "instead of Gates and learning,
// we should another new fresh tab, move… just the Today paper"). Inside Intel
// the edition was a collapsed one-liner because it buried the news desk; here
// the edition IS the page, so it mounts open — deferring it would defer the
// only thing the reader came for. The archive stays behind a <details>, its
// list fetch deferred exactly as before.

import { useState } from 'react'
import { ArchiveList, BulletinReader, EditionFrame } from './parts/EditionReader'

type PaperEdition = 'morning' | 'premarket' | 'evening'
const EDITIONS: { key: PaperEdition; label: string; note: string }[] = [
  { key: 'morning', label: 'Morning', note: 'research paper' },
  { key: 'premarket', label: 'Pre-market', note: 'before the US open' },
  { key: 'evening', label: 'Evening', note: 'session review' },
]

export default function Paper2() {
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [edition, setEdition] = useState<PaperEdition>('morning')
  return (
    <div className="paper2">
      <h1>Daily report</h1>
      <div className="paper2-editions" role="tablist" aria-label="Paper edition">
        {EDITIONS.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={edition === item.key}
            className={edition === item.key ? 'active' : ''}
            onClick={() => setEdition(item.key)}
          >
            <strong>{item.label}</strong>
            <span>{item.note}</span>
          </button>
        ))}
      </div>
      <section className="card itl-section" aria-label="The edition">
        {edition === 'morning' ? (
          <>
            <EditionFrame key={openDate ?? 'latest'} date={openDate ?? undefined} />
            <details className="itl-archive" open={archiveOpen}>
              <summary
                onClick={e => {
                  e.preventDefault()
                  setArchiveOpen(v => !v)
                }}
              >
                Archive
              </summary>
              {archiveOpen && <ArchiveList activeDate={openDate} onPick={setOpenDate} />}
            </details>
          </>
        ) : (
          <BulletinReader key={edition} kind={edition} />
        )}
      </section>
    </div>
  )
}
