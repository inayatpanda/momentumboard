import { useState } from 'react'

export function AddTickerForm({ onAdd, disabled }: { onAdd: (symbol: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="addform"
      onSubmit={e => {
        e.preventDefault()
        const s = value.trim().toUpperCase()
        if (s) {
          onAdd(s)
          setValue('')
        }
      }}
    >
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Add ticker — AAPL, NVDA or 3LTS.L"
        disabled={disabled}
        aria-label="Add ticker"
      />
      <button disabled={disabled}>Add</button>
    </form>
  )
}
