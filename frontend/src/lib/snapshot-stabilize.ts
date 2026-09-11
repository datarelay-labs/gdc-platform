import type {
  OperationalDestinationSnapshot,
  OperationalProblem,
  OperationalRouteSnapshot,
  OperationalSnapshotResponse,
  OperationalStreamSnapshot,
} from '../api/operationalSnapshot'

function streamSnapshotEqual(a: OperationalStreamSnapshot, b: OperationalStreamSnapshot): boolean {
  return (
    a.stream_id === b.stream_id &&
    a.stream_name === b.stream_name &&
    a.connector_id === b.connector_id &&
    a.source_id === b.source_id &&
    a.enabled === b.enabled &&
    a.status === b.status &&
    a.health_status === b.health_status &&
    a.eps_1m === b.eps_1m &&
    a.eps_5m === b.eps_5m &&
    a.success_rate_5m === b.success_rate_5m &&
    a.failure_rate_5m === b.failure_rate_5m &&
    a.avg_latency_ms === b.avg_latency_ms &&
    a.route_count === b.route_count &&
    a.healthy_route_count === b.healthy_route_count &&
    a.failed_route_count === b.failed_route_count &&
    a.last_success_at === b.last_success_at &&
    a.last_error_at === b.last_error_at &&
    a.last_error_message === b.last_error_message &&
    a.checkpoint_updated_at === b.checkpoint_updated_at &&
    a.checkpoint_lag_seconds === b.checkpoint_lag_seconds &&
    (a.open_schema_field_drift_count ?? 0) === (b.open_schema_field_drift_count ?? 0)
  )
}

function routeSnapshotEqual(a: OperationalRouteSnapshot, b: OperationalRouteSnapshot): boolean {
  return (
    a.route_id === b.route_id &&
    a.stream_id === b.stream_id &&
    a.stream_name === b.stream_name &&
    a.destination_id === b.destination_id &&
    a.destination_name === b.destination_name &&
    a.destination_type === b.destination_type &&
    a.enabled === b.enabled &&
    a.failure_policy === b.failure_policy &&
    a.health_status === b.health_status &&
    a.delivered_eps_1m === b.delivered_eps_1m &&
    a.failed_eps_1m === b.failed_eps_1m &&
    a.success_rate_5m === b.success_rate_5m &&
    a.retry_rate_5m === b.retry_rate_5m &&
    a.avg_latency_ms === b.avg_latency_ms &&
    a.last_success_at === b.last_success_at &&
    a.last_error_at === b.last_error_at &&
    a.last_error_message === b.last_error_message
  )
}

function destinationSnapshotEqual(
  a: OperationalDestinationSnapshot,
  b: OperationalDestinationSnapshot,
): boolean {
  return (
    a.destination_id === b.destination_id &&
    a.destination_name === b.destination_name &&
    a.destination_type === b.destination_type &&
    a.enabled === b.enabled &&
    a.health_status === b.health_status &&
    a.inbound_eps_1m === b.inbound_eps_1m &&
    a.failed_eps_1m === b.failed_eps_1m &&
    a.avg_latency_ms === b.avg_latency_ms &&
    a.route_count === b.route_count &&
    a.last_success_at === b.last_success_at &&
    a.last_error_at === b.last_error_at &&
    a.last_error_message === b.last_error_message
  )
}

function problemSnapshotEqual(a: OperationalProblem, b: OperationalProblem): boolean {
  return (
    a.severity === b.severity &&
    a.scope === b.scope &&
    a.title === b.title &&
    a.message === b.message &&
    a.stream_id === b.stream_id &&
    a.route_id === b.route_id &&
    a.destination_id === b.destination_id &&
    a.last_seen_at === b.last_seen_at
  )
}

function stabilizeProblems(prev: OperationalProblem[], next: OperationalProblem[]): OperationalProblem[] {
  if (prev.length !== next.length) return next
  let changed = false
  const out: OperationalProblem[] = []
  for (let i = 0; i < next.length; i++) {
    const prior = prev[i]!
    const item = next[i]!
    if (problemSnapshotEqual(prior, item)) {
      out.push(prior)
    } else {
      out.push(item)
      changed = true
    }
  }
  return changed ? out : prev
}

function stabilizeById<T extends { [key: string]: unknown }>(
  prev: T[] | undefined,
  next: T[],
  idKey: keyof T,
  equal: (a: T, b: T) => boolean,
): T[] {
  if (prev == null || prev.length !== next.length) return next
  const prevById = new Map<unknown, T>()
  for (const item of prev) prevById.set(item[idKey], item)
  let changed = false
  const out: T[] = []
  for (const item of next) {
    const prior = prevById.get(item[idKey])
    if (prior != null && equal(prior, item)) {
      out.push(prior)
    } else {
      out.push(item)
      changed = true
    }
  }
  if (!changed && out.every((item, i) => item === prev[i])) return prev
  return out
}

export type StabilizedOperationalSnapshot = OperationalSnapshotResponse & {
  streamsById: ReadonlyMap<number, OperationalStreamSnapshot>
}

export function stabilizeOperationalSnapshot(
  prev: StabilizedOperationalSnapshot | null,
  next: OperationalSnapshotResponse | null,
): StabilizedOperationalSnapshot | null {
  if (next == null) return null
  if (prev == null) {
    return {
      ...next,
      streamsById: new Map(next.streams.map((s) => [s.stream_id, s])),
    }
  }

  const streams = stabilizeById(prev.streams, next.streams, 'stream_id', streamSnapshotEqual)
  const routes = stabilizeById(prev.routes, next.routes, 'route_id', routeSnapshotEqual)
  const destinations = stabilizeById(
    prev.destinations,
    next.destinations,
    'destination_id',
    destinationSnapshotEqual,
  )
  const problems = stabilizeProblems(prev.problems, next.problems)

  const globalSame =
    prev.global.health_status === next.global.health_status &&
    prev.global.total_streams === next.global.total_streams &&
    prev.global.enabled_streams === next.global.enabled_streams &&
    prev.global.running_streams === next.global.running_streams &&
    prev.global.error_streams === next.global.error_streams &&
    prev.global.total_routes === next.global.total_routes &&
    prev.global.enabled_routes === next.global.enabled_routes &&
    prev.global.total_destinations === next.global.total_destinations &&
    prev.global.enabled_destinations === next.global.enabled_destinations &&
    prev.global.total_eps_1m === next.global.total_eps_1m &&
    prev.global.total_eps_5m === next.global.total_eps_5m &&
    prev.global.avg_latency_ms === next.global.avg_latency_ms &&
    prev.global.last_activity_at === next.global.last_activity_at

  const streamsById =
    streams === prev.streams
      ? prev.streamsById
      : new Map(streams.map((s) => [s.stream_id, s]))

  if (
    streams === prev.streams &&
    routes === prev.routes &&
    destinations === prev.destinations &&
    problems === prev.problems &&
    globalSame &&
    prev.updated_at === next.updated_at
  ) {
    return prev
  }

  return {
    global: globalSame ? prev.global : next.global,
    streams,
    routes,
    destinations,
    problems,
    updated_at: next.updated_at,
    streamsById,
  }
}
