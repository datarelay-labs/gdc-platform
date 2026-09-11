import { describe, expect, it } from 'vitest'
import { RUNTIME_UI_ENDPOINT_PATH_TEMPLATES } from './endpointContracts'

/** Frozen checklist from runtime UI contract — must stay aligned with `App.tsx` request paths. */
const TASK_REQUIRED_RUNTIME_PATHS = [
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

describe('runtime UI endpoint contract matrix', () => {
  it('documents exactly the task-required runtime paths with no duplicates', () => {
    expect(RUNTIME_UI_ENDPOINT_PATH_TEMPLATES.length).toBe(TASK_REQUIRED_RUNTIME_PATHS.length)
    expect(new Set(RUNTIME_UI_ENDPOINT_PATH_TEMPLATES).size).toBe(RUNTIME_UI_ENDPOINT_PATH_TEMPLATES.length)

    for (const p of TASK_REQUIRED_RUNTIME_PATHS) {
      expect(RUNTIME_UI_ENDPOINT_PATH_TEMPLATES as readonly string[]).toContain(p)
    }

    for (const p of RUNTIME_UI_ENDPOINT_PATH_TEMPLATES) {
      expect(TASK_REQUIRED_RUNTIME_PATHS as readonly string[]).toContain(p)
    }
  })
})
