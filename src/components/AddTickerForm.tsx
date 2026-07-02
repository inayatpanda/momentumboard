import { useState } from 'react'

export function AddTickerForm({ onAdd, disabled }: { onAdd: (symbol: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const s = value.trim().toUpperCase()
        if (s) {
          onAdd(s)
          setValue('')
        }
      }}
      style={{ display: 'flex', gap: 8, marginBottom: 12 }}
    >
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Add ticker (AAPL or 3LTS.L)"
        disabled={disabled}
        style={{ flex: 1, background: 'var(--panel)', border: '1px solid #2a3242', borderRadius: 8, padding: '8px 10px', color: 'var(--text)' }}
      />
      <button disabled={disabled} style={{ background: 'var(--accent)', border: 'none', borderRadius: 8, padding: '8px 14px', color: '#0b0e14', fontWeight: 600 }}>
        Add
      </button>
    </form>
  )
}
