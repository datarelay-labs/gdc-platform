/**
 * Documented runtime API paths used by the frontend (`requestJson` / `runtimeQuery`).
 * Placeholders `{id}` mean a URL segment; not valid URL templates by themselves.
 */
export const RUNTIME_UI_ENDPOINT_PATH_TEMPLATES = [
  '/api/v1/runtime/connectors/{id}/ui/config',
  '/api/v1/runtime/connectors/{id}/ui/save',
  '/api/v1/runtime/sources/{id}/ui/config',
  '/api/v1/runtime/sources/{id}/ui/save',
  '/api/v1/runtime/streams/{id}/ui/config',
  '/api/v1/runtime/streams/{id}/ui/save',
  '/api/v1/runtime/streams/{id}/mapping-ui/config',
  '/api/v1/runtime/streams/{id}/mapping-ui/save',
  '/api/v1/runtime/routes/{id}/ui/config',
  '/api/v1/runtime/routes/{id}/ui/save',
  '/api/v1/runtime/destinations/{id}/ui/config',
  '/api/v1/runtime/destinations/{id}/ui/save',
  '/api/v1/runtime/dashboard/summary',
  '/api/v1/runtime/operational-snapshot',
  '/api/v1/runtime/validation/operational-summary',
  '/api/v1/runtime/dashboard/outcome-timeseries',
  '/api/v1/runtime/health/stream/{id}',
  '/api/v1/runtime/stats/stream/{id}',
  '/api/v1/runtime/streams/{id}/stats-health',
  '/api/v1/runtime/streams/stats-health/bulk',
  '/api/v1/runtime/streams/{id}/metrics',
  '/api/v1/runtime/timeline/stream/{id}',
  '/api/v1/runtime/logs/search',
  '/api/v1/runtime/logs/alerts/summary',
  '/api/v1/runtime/logs/page',
  '/api/v1/runtime/logs/{id}/trace',
  '/api/v1/runtime/runs/{id}/trace',
  '/api/v1/runtime/system/resources',
  '/api/v1/runtime/logs/cleanup',
  '/api/v1/runtime/failures/trend',
  '/api/v1/runtime/streams/{id}/start',
  '/api/v1/runtime/streams/{id}/stop',
  '/api/v1/runtime/streams/{id}/run-once',
  '/api/v1/runtime/streams/{id}/pipeline-debug',
  '/api/v1/runtime/api-test/http',
  '/api/v1/runtime/api-test/connector-auth',
  '/api/v1/runtime/preview/mapping',
  '/api/v1/runtime/preview/format',
  '/api/v1/runtime/preview/route-delivery',
  '/api/v1/runtime/preview/sensitive-detection',
  '/api/v1/runtime/format-preview',
] as const

export type RuntimeUiEndpointPathTemplate = (typeof RUNTIME_UI_ENDPOINT_PATH_TEMPLATES)[number]

/** Template library API paths (`gdcTemplates.ts`). */
export const TEMPLATE_API_PATH_TEMPLATES = [
  '/api/v1/templates/',
  '/api/v1/templates/{template_id}',
  '/api/v1/templates/{template_id}/instantiate',
] as const

export type TemplateApiPathTemplate = (typeof TEMPLATE_API_PATH_TEMPLATES)[number]
