import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CalibrationPlot } from './CalibrationPlot'

describe('CalibrationPlot', () => {
  it('turns buckets into readable setup evidence instead of a self-referential scatter', () => {
    const { container } = render(
      <CalibrationPlot
        referenceBase={0.4}
        buckets={{
          'long:green:55-70': { n: 20, hits: 13 },
          'short:red:40-55': { n: 8, hits: 3 },
          'long:amber:25-40': { n: 4, hits: 2 }, // too thin — must not plot
        }}
      />,
    )
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByText('Engine hit rate')).toBeInTheDocument()
    expect(screen.getByText('Ordinary candidate')).toBeInTheDocument()
    expect(screen.getByText('green tape')).toBeInTheDocument()
    expect(screen.getByText('red tape')).toBeInTheDocument()
    expect(screen.getByText('65% hit')).toBeInTheDocument()
    expect(screen.getByText('+25pp vs bar')).toBeInTheDocument()
    expect(screen.getByText('n=20')).toBeInTheDocument()
    expect(screen.queryByText('amber tape')).not.toBeInTheDocument()
  })

  it('pools conviction bands and cohorts into one row per direction and tape', () => {
    render(
      <CalibrationPlot
        referenceBase={0.4}
        buckets={{
          'long:green:25-40': { n: 20, hits: 8 },
          'large:long:green:55-70': { n: 30, hits: 18 },
        }}
      />,
    )
    expect(screen.getByText('green tape')).toBeInTheDocument()
    expect(screen.getByText('long · green tape')).toBeInTheDocument()
    expect(screen.getByText('52% hit')).toBeInTheDocument()
    expect(screen.getByText('n=50')).toBeInTheDocument()
  })

  it('shows an empty note when no bucket clears the minimum', () => {
    const { container, getByText } = render(
      <CalibrationPlot buckets={{ 'long:green:25-40': { n: 3, hits: 1 } }} />,
    )
    expect(container.querySelector('.cal-row')).toBeNull()
    expect(getByText(/Not enough graded predictions/)).toBeInTheDocument()
  })
})
