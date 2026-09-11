/** Build-time gates for incomplete or internal-only operator UI. */

/**
 * OSS v1.0 Release Candidate surface.
 * Production Docker images set VITE_OSS_RELEASE_MODE=true at build time.
 * Set VITE_OSS_RELEASE_MODE=false locally to expose dev/validation tooling.
 */
export function isOssReleaseMode(): boolean {
  const raw = import.meta.env.VITE_OSS_RELEASE_MODE
  if (raw === 'false' || raw === '0' || raw === 'off') return false
  if (raw === 'true' || raw === '1' || raw === 'on') return true
  return import.meta.env.PROD
}

export function isDevValidationLabUiEnabled(): boolean {
  if (isOssReleaseMode()) return false
  if (import.meta.env.VITE_ENABLE_DEV_VALIDATION_LAB === 'true') return true
  return import.meta.env.MODE === 'development'
}

export function isPlatformAlertingUiEnabled(): boolean {
  if (isOssReleaseMode()) return false
  return import.meta.env.VITE_ENABLE_PLATFORM_ALERTING_UI === 'true'
}

/** Internal / experimental routes hidden from OSS release navigation. */
export function isInternalOperatorUiEnabled(): boolean {
  return !isOssReleaseMode()
}

/**
 * AI Gateway is not Data Relay OSS product scope.
 * Operator UI stays off regardless of build-time env.
 */
export function isAiGatewayFoundationEnabled(): boolean {
  return false
}
