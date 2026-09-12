/**
 * Shared operational metric formatting contract for Data Relay frontend.
 *
 * Rules (adapted from operational readout principles; Data Relay conventions win):
 * 1. A non-zero rate/count NEVER renders as bare "0".
 * 2. A non-100% value NEVER renders as "100%".
 * 3. Rates and counts use different formatters — never interchange them.
 * 4. Invalid numerics (null / undefined / NaN / Infinity / unexpected negative)
 *    use one sentinel: OPERATIONAL_METRIC_NA ("—").
 * 5. Number formatting is separate from health classification (HEALTHY / DEGRADED / …).
 */

/** Single invalid/missing numeric sentinel used across operational UI. */
export const OPERATIONAL_METRIC_NA = '—'

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Bare EPS / throughput rate (no unit suffix).
 *
 * Precision follows existing Data Relay UI:
 * - integers and values ≥1: up to 2 fraction digits
 * - values in [0.01, 1): up to 3 fraction digits
 * - positive values below 0.01: "<0.01" (never "0")
 *
 * Note: historical callers treat null/non-finite as "0". Prefer
 * {@link formatOperationalRate} when the NA sentinel is required.
 */
export function formatThroughputEps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '0'
  if (value < 0) return '0'
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (value >= 0.01) return value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return '<0.01'
}

/**
 * Operational rate with invalid → NA. Bare number (caller adds "EPS" / "/s" / "events/sec").
 */
export function formatOperationalRate(value: number | null | undefined): string {
  const v = finiteOrNull(value)
  if (v == null || v < 0) return OPERATIONAL_METRIC_NA
  return formatThroughputEps(v)
}

/**
 * Success / delivery / failure percentage on the Data Relay 0–100 scale.
 * Values short of 100 never round up to a perfect 100%.
 */
export function formatOperationalPercent(pct: number | null | undefined): string {
  const v = finiteOrNull(pct)
  if (v == null || v < 0) return OPERATIONAL_METRIC_NA
  if (v === 0) return '0%'
  if (v > 0 && v < 0.01) return '<0.01%'

  if (v >= 100) {
    if (v === 100) return '100%'
    // Oversubscription / >100 is legitimate for some failure+retry views.
    return `${Math.round(v * 100) / 100}%`
  }

  // Prefer two-decimal rounding used across Streams / Routes KPIs, but never
  // allow a sub-100 value to display as 100%.
  const rounded = Math.round(v * 100) / 100
  if (rounded >= 100) {
    const floored = Math.floor(v * 100) / 100
    return `${floored.toFixed(2)}%`
  }
  return `${rounded}%`
}

/**
 * Same as {@link formatOperationalPercent} with an explicit `known` gate
 * (Streams console success cells).
 */
export function formatOperationalPercentKnown(pct: number, known: boolean): string {
  if (!known) return OPERATIONAL_METRIC_NA
  return formatOperationalPercent(pct)
}

/**
 * Integer-ish operational counts (events, rows). Never use rate formatters.
 * Compact only at ≥1000 when `compact` is true; default is locale grouping.
 */
export function formatOperationalCount(
  value: number | null | undefined,
  opts?: { compact?: boolean },
): string {
  const v = finiteOrNull(value)
  if (v == null || v < 0) return OPERATIONAL_METRIC_NA
  if (v === 0) return '0'
  if (v > 0 && v < 1) return '<1'

  const n = Math.round(v)
  if (opts?.compact) {
    if (n >= 1_000_000) {
      const m = n / 1_000_000
      return `${m.toFixed(1).replace(/\.0$/, '')}M`
    }
    if (n >= 1_000) {
      const k = n / 1_000
      return `${k.toFixed(1).replace(/\.0$/, '')}K`
    }
  }
  return n.toLocaleString()
}
