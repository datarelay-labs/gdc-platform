import { describe, expect, it } from 'vitest'
import {
  OPERATIONAL_METRIC_NA,
  formatOperationalCount,
  formatOperationalPercent,
  formatOperationalPercentKnown,
  formatOperationalRate,
  formatThroughputEps,
} from './observability-format'

describe('formatThroughputEps', () => {
  it('does not round non-zero throughput to zero', () => {
    expect(formatThroughputEps(1.234)).toBe('1.23')
    expect(formatThroughputEps(0.01234)).toBe('0.012')
    expect(formatThroughputEps(0.001)).toBe('<0.01')
    expect(formatThroughputEps(0)).toBe('0')
  })

  it('keeps sparse 24h stream rates visibly non-zero', () => {
    expect(formatThroughputEps(9 / 86_400)).toBe('<0.01')
    expect(formatThroughputEps(296 / 86_400)).toBe('<0.01')
    expect(formatThroughputEps(0.000001)).toBe('<0.01')
  })

  it('regression: 0.93 EPS must not equal "0"', () => {
    expect(formatThroughputEps(0.93)).not.toBe('0')
    expect(formatThroughputEps(0.93)).toBe('0.93')
  })

  it('formats integer and large values without inventing zero', () => {
    expect(formatThroughputEps(39)).toBe('39')
    expect(formatThroughputEps(9.67)).toBe('9.67')
    expect(formatThroughputEps(1250)).toBe('1,250')
  })
})

describe('formatOperationalRate', () => {
  it('uses NA for invalid inputs', () => {
    expect(formatOperationalRate(null)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalRate(undefined)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalRate(Number.NaN)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalRate(Number.POSITIVE_INFINITY)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalRate(-1)).toBe(OPERATIONAL_METRIC_NA)
  })

  it('formats zero, fractional, and small positive rates', () => {
    expect(formatOperationalRate(0)).toBe('0')
    expect(formatOperationalRate(0.04)).toBe('0.04')
    expect(formatOperationalRate(0.004)).toBe('<0.01')
    expect(formatOperationalRate(0.93)).toBe('0.93')
    expect(formatOperationalRate(0.93)).not.toBe('0')
  })
})

describe('formatOperationalPercent', () => {
  it('formats zero and exact 100', () => {
    expect(formatOperationalPercent(0)).toBe('0%')
    expect(formatOperationalPercent(100)).toBe('100%')
  })

  it('never rounds a sub-100 value up to 100%', () => {
    expect(formatOperationalPercent(99.96)).toBe('99.96%')
    expect(formatOperationalPercent(99.96)).not.toBe('100%')
    expect(formatOperationalPercent(99.996)).not.toMatch(/^100/)
    expect(formatOperationalPercent(99.999)).not.toMatch(/^100/)
  })

  it('keeps ordinary rates readable', () => {
    expect(formatOperationalPercent(1)).toBe('1%')
    expect(formatOperationalPercent(92.5)).toBe('92.5%')
    expect(formatOperationalPercent(99.86)).toBe('99.86%')
  })

  it('uses NA for invalid inputs', () => {
    expect(formatOperationalPercent(null)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalPercent(undefined)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalPercent(Number.NaN)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalPercent(Number.POSITIVE_INFINITY)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalPercent(-0.5)).toBe(OPERATIONAL_METRIC_NA)
  })

  it('respects known gate', () => {
    expect(formatOperationalPercentKnown(99.5, false)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalPercentKnown(99.5, true)).toBe('99.5%')
  })
})

describe('formatOperationalCount', () => {
  it('formats counts without rate semantics', () => {
    expect(formatOperationalCount(0)).toBe('0')
    expect(formatOperationalCount(3968)).toBe('3,968')
    expect(formatOperationalCount(0.4)).toBe('<1')
  })

  it('supports compact counts when requested', () => {
    expect(formatOperationalCount(1250, { compact: true })).toBe('1.3K')
    expect(formatOperationalCount(2_300_000, { compact: true })).toBe('2.3M')
  })

  it('uses NA for invalid inputs', () => {
    expect(formatOperationalCount(null)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalCount(undefined)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalCount(Number.NaN)).toBe(OPERATIONAL_METRIC_NA)
    expect(formatOperationalCount(Number.NEGATIVE_INFINITY)).toBe(OPERATIONAL_METRIC_NA)
  })
})
