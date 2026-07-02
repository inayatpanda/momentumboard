import { useState } from 'react'
import type { RuleItem } from '../lib/db'

export function AlertEditor({
  symbol,
  rules,
  onSave,
  onDelete,
}: {
  symbol: string
  rules: RuleItem[]
  onSave: (kind: 'priceAbove' | 'priceBelow', level: number) => void
  onDelete: (id: string) => void
}) {
  const above = rules.find(r => r.kind === 'priceAbove')
  const below = rules.find(r => r.kind === 'priceBelow')
  const [aboveVal, setAboveVal] = useState(above ? String(above.level) : '')
  const [belowVal, setBelowVal] = useState(below ? String(below.level) : '')

  const save = () => {
    const a = parseFloat(aboveVal)
    const b = parseFloat(belowVal)
    if (aboveVal && !Number.isNaN(a)) onSave('priceAbove', a)
    else if (!aboveVal && above) onDelete(above.id)
    if (belowVal && !Number.isNaN(b)) onSave('priceBelow', b)
    else if (!belowVal && below) onDelete(below.id)
  }

  return (
    <div className="alert-editor">
      <label>
        Ping above
        <input inputMode="decimal" placeholder="—" value={aboveVal} onChange={e => setAboveVal(e.target.value)} aria-label={`${symbol} alert above`} />
      </label>
      <label>
        Ping below
        <input inputMode="decimal" placeholder="—" value={belowVal} onChange={e => setBelowVal(e.target.value)} aria-label={`${symbol} alert below`} />
      </label>
      <button onClick={save}>Set</button>
    </div>
  )
}
