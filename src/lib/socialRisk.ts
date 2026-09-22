export interface SocialRiskInput {
  capUsdM?: number | null
  surgeMultiple: number | null
  sources: number
  redditMentions: number | null
  firstSeenAt?: number | null
  observedDays?: number | null
  redditEngagement?: number | null
  channelBreadth?: number | null
  channelHype?: number
}

export interface SocialRiskRead {
  level: 'lower' | 'guarded' | 'elevated' | 'high'
  early: boolean
  stage: 'new' | 'accelerating' | 'confirmed' | 'crowded' | 'unconfirmed'
  reasons: string[]
}

/** A manipulation/chase risk flag, never an accusation or a trade signal. */
export function assessSocialRisk(row: SocialRiskInput, nowSec = Math.floor(Date.now() / 1000)): SocialRiskRead {
  const ageHours = row.firstSeenAt ? Math.max(0, (nowSec - row.firstSeenAt) / 3600) : null
  const early = ageHours != null ? ageHours <= 48 : (row.observedDays ?? 99) <= 2
  let score = 0
  const reasons: string[] = []
  if (row.capUsdM == null) { score += 1; reasons.push('market cap/float incomplete') }
  else if (row.capUsdM < 300) { score += 3; reasons.push('micro-cap') }
  else if (row.capUsdM < 1_000) { score += 2; reasons.push('small-cap') }
  else if (row.capUsdM < 3_000) score += 1
  if ((row.surgeMultiple ?? 0) >= 5) { score += 3; reasons.push(`${row.surgeMultiple}x chatter burst`) }
  else if ((row.surgeMultiple ?? 0) >= 3) { score += 2; reasons.push(`${row.surgeMultiple}x chatter acceleration`) }
  else if ((row.surgeMultiple ?? 0) >= 2) score += 1
  if (row.sources <= 1) { score += 2; reasons.push('single-platform signal') }
  else { score -= 1; reasons.push(`${row.sources}-platform confirmation`) }
  if ((row.redditMentions ?? 0) >= 500) { score += 1; reasons.push('already crowded') }
  if ((row.channelHype ?? 0) > 0) { score += Math.min(2, row.channelHype ?? 0); reasons.push('creator hype language detected') }
  if ((row.redditMentions ?? 0) >= 100 && (row.redditEngagement ?? 99) < 1) { score += 1; reasons.push('mentions outrun engagement') }
  if ((row.channelBreadth ?? 0) >= 2) score -= 1
  const level: SocialRiskRead['level'] = score >= 6 ? 'high' : score >= 4 ? 'elevated' : score >= 2 ? 'guarded' : 'lower'
  const stage: SocialRiskRead['stage'] =
    (row.observedDays ?? 0) >= 5 && (row.redditMentions ?? 0) >= 200 ? 'crowded'
      : early ? 'new'
        : (row.surgeMultiple ?? 0) >= 2 ? 'accelerating'
          : row.sources >= 2 ? 'confirmed'
            : 'unconfirmed'
  return { level, early, stage, reasons }
}
