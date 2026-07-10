import { useState } from 'react'

export function AddTickerForm({ onAdd, disabled, categories = [] }: { onAdd: (symbol: string, category?: string) => void; disabled: boolean; categories?: string[] }) {
  const [value, setValue] = useState('')
  const [category, setCategory] = useState('')
  return (
    <form
      className="addform add-pill"
      onSubmit={e => {
        e.preventDefault()
        const s = value.trim().toUpperCase()
        if (s) {
          onAdd(s, category.trim() || undefined)
          setValue('')
        }
      }}
    >
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Add ticker: AAPL or 3LTS.L"
        disabled={disabled}
        aria-label="Add ticker"
      />
      <input
        value={category}
        onChange={e => setCategory(e.target.value)}
        placeholder="Category"
        list="mb-categories"
        disabled={disabled}
        aria-label="Category"
        style={{ flex: '0 0 110px' }}
      />
      <datalist id="mb-categories">
        {categories.map(c => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <button disabled={disabled}>Add</button>
    </form>
  )
}
