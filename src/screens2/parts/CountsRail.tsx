// CountsRail (plan Task 13) — the "everything else, one tap deeper" strip
// from the ratified Today-stack mockup: Developing/Watch counts read straight
// off the board rows already in hand (no extra fetch), and Refused links
// through to the Board with NO count — the amendment overriding the original
// brief: fetching the funnel slice just to paint a chip's number is not worth
// a network trip on the home screen's mount.

import { Link } from 'wouter'
import type { EnginePrediction } from '../../lib/api'

export function CountsRail({ board }: { board: EnginePrediction[] }) {
  // same taxonomy src/components/EngineBoard.tsx:252-253 sorts the board into:
  // nearMiss/observation rows are never "developing" or "watch", they are
  // their own thing and have no chip here.
  const trackable = board.filter(p => p.watchOnly && !p.nearMiss && !p.observation)
  const developing = trackable.filter(p => p.horizon === 'developing').length
  const watch = trackable.filter(p => p.horizon !== 'developing').length
  return (
    <div className="hrail">
      <Link href="/board#developing" className="pill pressable">
        Developing · {developing}
      </Link>
      <Link href="/board#watch" className="pill pressable">
        Watch · {watch}
      </Link>
      <Link href="/board#refused" className="pill pressable">
        Refused
      </Link>
    </div>
  )
}
