import type { AppNavKey } from './app-navigation'

/** Browser paths for primary sidebar destinations (SPA). */
export const NAV_PATH: Record<AppNavKey, string> = {
  dashboard: '/monitoring',
  streams: '/streams',
  monitoring: '/monitoring',
  logs: '/logs',
  governance: '/governance',
  administration: '/admin',
  connectors: '/connectors',
  mappings: '/mappings',
  destinations: '/destinations',
  routes: '/routes',
  runtime: '/monitoring/streams',
  topology: '/monitoring/topology',
  analytics: '/monitoring/analytics',
  aiGateway: '/ai-gateway/traffic',
  aiGatewayProviders: '/ai-gateway/providers',
  aiGatewayStreams: '/ai-gateway/streams',
  aiGatewayTraffic: '/ai-gateway/traffic',
  aiGatewayGovernance: '/ai-gateway/governance',
  governanceDataProtection: '/governance/data-protection',
  governanceOperations: '/governance/operations',
  governanceViolations: '/governance/violations',
  governanceQuarantine: '/governance/quarantine',
  governanceAudit: '/governance/audit',
  governanceApprovals: '/governance/approvals',
  governanceReplay: '/governance/replay',
  governanceNotifications: '/governance/notifications',
  governanceWorkspace: '/governance/workspace',
  validation: '/validation',
  templates: '/templates',
  connectorCatalog: '/admin/connector-catalog',
  backup: '/operations/backup',
  settings: '/settings',
}

/** New stream wizard (frontend-only flow). */
export function newStreamPath(): string {
  return '/streams/new'
}

export function streamRuntimePath(streamId: string, options?: { tab?: string }): string {
  const base = `/streams/${encodeURIComponent(streamId)}/runtime`
  const tab = options?.tab?.trim()
  if (tab && tab !== 'overview') {
    const q = new URLSearchParams()
    q.set('tab', tab)
    return `${base}?${q.toString()}`
  }
  return base
}

/** Streams console with a source-product group row pre-expanded (dashboard drill-down). */
export function streamsExpandedGroupPath(productLabel: string, options?: { filter?: string }): string {
  const label = productLabel.trim()
  if (!label && !options?.filter) return NAV_PATH.streams
  const q = new URLSearchParams()
  if (options?.filter) q.set('filter', options.filter)
  if (label) q.set('expand_group', label)
  const qs = q.toString()
  return qs ? `${NAV_PATH.streams}?${qs}` : NAV_PATH.streams
}

/** API test & JSON preview step (stream wizard / edit flow). */
export function streamApiTestPath(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}/api-test`
}

export function streamEnrichmentPath(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}/enrichment`
}

export function streamMappingPath(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}/mapping`
}

export function streamEditPath(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}/edit`
}

/** Stream wizard step keys (aligned with WIZARD_STEP_KEYS in wizard-state). */
export type StreamWizardStepKey =
  | 'connect'
  | 'sample'
  | 'destinations'
  | 'route_processing'
  | 'deploy'

/** Edit wizard deep link — optional `step` opens the matching v5.2 wizard step. */
export function streamEditWizardStepPath(streamId: string, step?: StreamWizardStepKey): string {
  const base = streamEditPath(streamId)
  if (!step) return base
  const q = new URLSearchParams()
  q.set('step', step)
  return `${base}?${q.toString()}`
}

export function mappingEditPath(mappingId: string): string {
  return `/mappings/${encodeURIComponent(mappingId)}/edit`
}

export function routeEditPath(routeId: string): string {
  return `/routes/${encodeURIComponent(routeId)}/edit`
}

/** Logs explorer scoped to a stream (slug → label resolved in UI). */
export function logsPath(streamSlug?: string): string {
  if (!streamSlug || streamSlug.trim() === '') return '/logs'
  return `/logs/${encodeURIComponent(streamSlug)}`
}

/** Logs explorer with delivery_logs drill-down filters (numeric IDs match backend). */
export function logsExplorerPath(filters?: {
  route_id?: number
  stream_id?: number
  destination_id?: number
  run_id?: string
  partial_success?: boolean
  stage?: string
  status?: string
}): string {
  const q = new URLSearchParams()
  if (filters?.route_id != null && Number.isFinite(filters.route_id)) q.set('route_id', String(filters.route_id))
  if (filters?.stream_id != null && Number.isFinite(filters.stream_id)) q.set('stream_id', String(filters.stream_id))
  if (filters?.destination_id != null && Number.isFinite(filters.destination_id)) {
    q.set('destination_id', String(filters.destination_id))
  }
  if (filters?.run_id != null && String(filters.run_id).trim() !== '') q.set('run_id', String(filters.run_id).trim())
  if (filters?.partial_success === true) q.set('partial_success', 'true')
  if (filters?.partial_success === false) q.set('partial_success', 'false')
  if (filters?.stage != null && filters.stage.trim() !== '') q.set('stage', filters.stage.trim())
  if (filters?.status != null && filters.status.trim() !== '') q.set('status', filters.status.trim())
  const qs = q.toString()
  return qs ? `/logs?${qs}` : '/logs'
}

/** Runtime analytics with optional scope filters (numeric IDs match backend). */
export function runtimeAnalyticsPath(filters?: {
  window?: string
  stream_id?: number
  route_id?: number
  destination_id?: number
}): string {
  const q = new URLSearchParams()
  if (filters?.window != null && filters.window.trim() !== '') q.set('window', filters.window.trim())
  if (filters?.stream_id != null && Number.isFinite(filters.stream_id)) q.set('stream_id', String(filters.stream_id))
  if (filters?.route_id != null && Number.isFinite(filters.route_id)) q.set('route_id', String(filters.route_id))
  if (filters?.destination_id != null && Number.isFinite(filters.destination_id)) {
    q.set('destination_id', String(filters.destination_id))
  }
  const qs = q.toString()
  return qs ? `${NAV_PATH.analytics}?${qs}` : NAV_PATH.analytics
}

/** Platform monitoring with stream/route/destination drill-down (numeric IDs match backend). */
export function runtimeOverviewPath(filters?: {
  stream_id?: number
  route_id?: number
  destination_id?: number
  run_id?: string
}): string {
  const q = new URLSearchParams()
  if (filters?.stream_id != null && Number.isFinite(filters.stream_id)) q.set('stream_id', String(filters.stream_id))
  if (filters?.route_id != null && Number.isFinite(filters.route_id)) q.set('route_id', String(filters.route_id))
  if (filters?.destination_id != null && Number.isFinite(filters.destination_id)) {
    q.set('destination_id', String(filters.destination_id))
  }
  if (filters?.run_id != null && String(filters.run_id).trim() !== '') q.set('run_id', String(filters.run_id).trim())
  const qs = q.toString()
  const base = NAV_PATH.runtime
  return qs ? `${base}?${qs}` : base
}

export function connectorDetailPath(connectorId: string): string {
  return `/connectors/${encodeURIComponent(connectorId)}`
}

export function destinationDetailPath(destinationId: string): string {
  return `/destinations/${encodeURIComponent(destinationId)}`
}

function isDashboardPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/monitoring' ||
    pathname.startsWith('/monitoring/') ||
    pathname === '/runtime' ||
    pathname.startsWith('/runtime/')
  )
}

function isAdministrationPath(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/operations/backup') ||
    pathname.startsWith('/validation')
  )
}

/** Settings section deep links (existing Admin settings page). */
export const SETTINGS_SECTION_PATH = {
  https: '/settings#admin-https-heading',
  userManagement: '/settings#admin-users-heading',
  passwordManagement: '/settings#admin-password-heading',
  network: '/settings#admin-network-heading',
  retention: '/settings#admin-retention-heading',
  audit: '/settings/audit-logs',
  systemHealth: '/settings#admin-health-heading',
} as const

/** Derive which sidebar item is active from the current location. */
export function appNavKeyFromPathname(pathname: string): AppNavKey {
  if (pathname.startsWith('/templates')) return 'templates'
  if (pathname.startsWith('/streams')) return 'streams'
  if (isDashboardPath(pathname)) return 'dashboard'
  if (pathname.startsWith('/logs')) return 'logs'
  if (pathname.startsWith('/governance/data-protection')) return 'governanceDataProtection'
  if (pathname.startsWith('/governance/operations')) return 'governanceOperations'
  if (pathname.startsWith('/governance/violations')) return 'governanceViolations'
  if (pathname.startsWith('/governance/quarantine')) return 'governanceQuarantine'
  if (pathname.startsWith('/governance/audit')) return 'governanceAudit'
  if (pathname.startsWith('/governance/approvals')) return 'governanceApprovals'
  if (pathname.startsWith('/governance/replay')) return 'governanceReplay'
  if (pathname.startsWith('/governance/notifications')) return 'governanceNotifications'
  if (pathname.startsWith('/governance/workspace')) return 'governanceWorkspace'
  if (pathname.startsWith('/governance')) return 'governance'
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'administration'
  if (pathname.startsWith('/connectors')) return 'connectors'
  if (pathname.startsWith('/destinations')) return 'destinations'
  if (pathname.startsWith('/routes')) return 'routes'
  if (pathname.startsWith('/settings')) return 'settings'
  if (pathname.startsWith('/operations/backup')) return 'backup'
  if (pathname.startsWith('/validation')) return 'validation'
  if (pathname.startsWith('/mappings')) return 'mappings'
  if (isAdministrationPath(pathname)) return 'administration'
  return 'streams'
}

/** Map legacy runtime paths to canonical monitoring paths (preserves query + hash). */
export function legacyRuntimeRedirectTarget(pathname: string, search: string, hash: string): string | null {
  if (pathname === '/runtime') return `${NAV_PATH.dashboard}${search}${hash}`
  if (pathname === '/runtime/topology') return `${NAV_PATH.dashboard}${search}${hash}`
  if (pathname === '/runtime/analytics') return `${NAV_PATH.dashboard}${search}${hash}`
  if (pathname === '/runtime/ai-gateway') return `${NAV_PATH.streams}${search}${hash}`
  return null
}
