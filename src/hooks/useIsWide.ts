import { useEffect, useState } from 'react'

/** True on desktop-class viewports — drives the wide "Desk" dashboard, which is
 * only offered at ≥1200px so the phone/tablet PWA layout is never disturbed.
 * Subscribes to viewport changes so rotating/resizing across the line updates. */
export function useIsWide(minWidth = 1200): boolean {
  const query = `(min-width: ${minWidth}px)`
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return wide
}
