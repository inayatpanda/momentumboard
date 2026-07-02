import { render, screen, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import { AlertEditor } from './AlertEditor'

it('saves parsed price levels', () => {
  const onSave = vi.fn()
  render(<AlertEditor symbol="AAPL" rules={[]} onSave={onSave} onDelete={() => {}} />)
  fireEvent.change(screen.getByLabelText('AAPL alert above'), { target: { value: '305.5' } })
  fireEvent.click(screen.getByText('Set'))
  expect(onSave).toHaveBeenCalledWith('priceAbove', 305.5)
})

it('deletes a rule when its field is cleared', () => {
  const onDelete = vi.fn()
  render(
    <AlertEditor
      symbol="AAPL"
      rules={[{ id: 'r1', symbol: 'AAPL', kind: 'priceAbove', level: 300, createdAt: 0 }]}
      onSave={() => {}}
      onDelete={onDelete}
    />,
  )
  fireEvent.change(screen.getByLabelText('AAPL alert above'), { target: { value: '' } })
  fireEvent.click(screen.getByText('Set'))
  expect(onDelete).toHaveBeenCalledWith('r1')
})
