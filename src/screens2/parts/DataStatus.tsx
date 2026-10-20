/** Failed requests must end loading; missing evidence is never a zero result. */
export function DataStatus({ label, error, refresh, refreshing }: { label: string; error?: string | null; refresh: () => void; refreshing?: boolean }) {
  return error ? <div className="data-status" role="alert" aria-label={`${label} unavailable`}>
    <p className="cc-reason">{label} could not be loaded. Try again to check for an update.</p>
    <button className="stocks-text-link" type="button" onClick={refresh} disabled={refreshing}>{refreshing ? 'Checking…' : `Retry ${label.toLowerCase()}`}</button>
  </div> : <p className="cc-reason data-status" role="status">Loading {label.toLowerCase()}…</p>
}
