export interface WorkItem {
  id: string
  kind: 'video' | 'dossier' | 'compose'
  body: unknown
  at: number
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  lastAttemptAt?: number
}

export interface WorkResult { ok: boolean; reason?: string; retryAfterSec?: number }

/** Never persist provider bodies: they can contain credentials or untrusted
 * messages. Public diagnostics use only an allowlisted reason or HTTP class. */
export function videoFailureReason(status: number, body: string): string {
  const reasons = ['caption-job-pending', 'extraction-in-progress', 'video-processing', 'provider-job-expired', 'provider-job-failed', 'publication-busy', 'extraction-provider-failed', 'video-text-fallback-capped', 'extract-daily-cap', 'gemini-extract-capped', 'daily-cap', 'no-transcript-gemini-watch-capped', 'no-transcript-no-video-read', 'unparseable-extract', 'bad-url', 'bad-json', 'bad-mode', 'unauthorized']
  return reasons.includes(body) ? body : status === 401 || status === 403 ? 'provider-auth-error' : status === 429 ? 'provider-rate-limit' : status >= 500 ? 'provider-unavailable' : 'analysis-request-failed'
}

export function workResultFromResponse(status: number, body: string, retryAfter: string | null): WorkResult {
  // Transitional protection for jobs returning an old HTTP-200 failure during
  // a staggered deploy. Successful HTTP alone is not proof of an extraction.
  const legacyFailure = ['unparseable', 'unparseable-extract', 'gemini-extract-capped', 'extract-daily-cap', 'daily-cap'].includes(body)
  if (status < 400 && !legacyFailure) return { ok: true }
  const delay = Number(retryAfter)
  return {
    ok: false, reason: videoFailureReason(status, body),
    ...(status === 429 && Number.isFinite(delay) && delay > 0 ? { retryAfterSec: Math.min(86_400, delay) } : {}),
  }
}

export function applyWorkResults(items: WorkItem[], results: Map<string, WorkResult>, nowSec: number): { next: WorkItem[]; deadlettered: WorkItem[] } {
  const next: WorkItem[] = [], deadlettered: WorkItem[] = []
  for (const item of items) {
    const result = results.get(item.id)
    if (!result) { next.push(item); continue }
    if (result.ok) continue
    const deferred = result.retryAfterSec != null
    const updated = { ...item, attempts: (item.attempts ?? 0) + (deferred ? 0 : 1), lastError: result.reason ?? 'worker-error', lastAttemptAt: nowSec, nextAttemptAt: nowSec + (result.retryAfterSec ?? 900) }
    // Budget deferrals must survive until tomorrow; real errors still have a
    // finite retry budget. Nothing is silently discarded after its last try.
    if (updated.attempts >= 3 || nowSec - item.at > 7 * 86_400) deadlettered.push(updated)
    else next.push(updated)
  }
  return { next, deadlettered }
}
