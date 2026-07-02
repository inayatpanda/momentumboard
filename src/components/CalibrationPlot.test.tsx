import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CalibrationPlot } from './CalibrationPlot'

describe('CalibrationPlot', () => {
  it('plots a dot per bucket with n>=5 and skips thin ones', () => {
    const { container, getByText } = render(
      <CalibrationPlot
        buckets={{
          'long:green:55-70': { n: 20, hits: 13 },
          'short:red:40-55': { n: 8, hits: 3 },
          'long:amber:25-40': { n: 4, hits: 2 }, // too thin — must not plot
        }}
      />,
    )
    const dots = container.querySelectorAll('circle')
    expect(dots.length).toBe(2)
    // hover label carries the bucket identity + counts
    expect(getByText(/long · green · band 55-70/)).toBeInTheDocument()
  })

  it('shows an empty note when no bucket clears the minimum', () => {
    const { container, getByText } = render(
      <CalibrationPlot buckets={{ 'long:green:25-40': { n: 3, hits: 1 } }} />,
    )
    expect(container.querySelector('circle')).toBeNull()
    expect(getByText(/Not enough graded predictions/)).toBeInTheDocument()
  })
})
