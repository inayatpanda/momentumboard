import { AnimatePresence, motion } from 'motion/react'
import type { Toast } from '../hooks/useAlerts'
import { IconBell, stripEmoji } from './icons'

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            className="toast"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          >
            <IconBell /> {stripEmoji(t.text)}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
