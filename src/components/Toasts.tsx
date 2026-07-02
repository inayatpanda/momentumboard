import type { Toast } from '../hooks/useAlerts'
import { IconBell } from './icons'

export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className="toast">
          <IconBell /> {t.text}
        </div>
      ))}
    </div>
  )
}
