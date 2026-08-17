// The paper — its own page (owner 2026-08-17: "instead of Gates and learning,
// we should another new fresh tab, move… just the Today paper"). Inside Intel
// the edition was a collapsed one-liner because it buried the news desk; here
// the edition IS the page, so it mounts open — deferring it would defer the
// only thing the reader came for. The archive stays behind a <details>, its
// list fetch deferred exactly as before.

import { useState } from 'react'
import { ArchiveList, EditionFrame } from './parts/EditionReader'

export default function Paper2() {
  const [openDate, setOpenDate] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  return (
    <div className="paper2">
      <h1>The paper</h1>
      <section className="card itl-section" aria-label="The edition">
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
      </section>
    </div>
  )
}
