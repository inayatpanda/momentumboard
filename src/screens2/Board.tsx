// Board (plan Task 14) — the whole engine's mind as one conviction-ranked
// scroll (brainstorm/67693-1786687483/content/home-layout.html, option B
// "Ranked board").
//
// The ranked list itself lives in `parts/BoardColumn.tsx` (extracted at Task
// 22): at ≥1200px the desk renders the SAME component as its board column
// beside the detail pane, so the two surfaces cannot drift and the `board`
// slice is read through one cache. This screen is that list under a title.

import BoardColumn from './parts/BoardColumn'

export default function Board() {
  return (
    <div className="board2">
      <h1>Board</h1>
      <BoardColumn />
    </div>
  )
}
