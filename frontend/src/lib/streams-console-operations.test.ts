import { describe, expect, it } from 'vitest'
import type { StreamConsoleRow } from '../api/streamRows'
import {
  buildProblemStreamItems,
  compareGroupsProblemFirst,
  compareStreamsProblemFirst,
  computeStreamOperationsSummary,
  filterStreamRows,
  matchesOperationalFilterFallback,
  sortGroupsProblemFirst,
  sortStreamsProblemFirst,
  streamIdsMatchingOperationalFilter,
  streamMatchesSearch,
} from './streams-console-operations'

function row(partial: Partial<StreamConsoleRow> & Pick<StreamConsoleRow, 'id' | 'name' | 'status'>): StreamConsoleRow {
  return {
    connectorId: 10,
    connectorName: 'Office365 Connector',
    connectorProductGroup: 'Office365',
    sourceTypeLabel: 'API',
    runtimeStatsAttempted: true,
    hasRuntimeApiSnapshot: true,
    events1h: 100,
    events24h: 0,
    ingestEps: 0,
    eps1m: null,
    eps5m: null,
    successRate5m: null,
    runtimeIssue: null,
    eventsTrend: [1, 2, 3],
    lastCheckpointDisplay: '—',
    lastCheckpointRelative: '—',
    routesTotal: 1,
    routesOk: 1,
    routesDegraded: 0,
    routesError: 0,
    deliveryPct: 100,
    deliveryPctKnown: true,
    latencyP95Ms: 10,
    latencyTrend: [1],
    lastActivityRelative: '1m ago',
    streamType: 'HTTP',
    streamTypeKey: 'HTTP_API_POLLING',
    pollingIntervalSec: 60,
    createdAt: '',
    createdBy: '',
    sourceMethod: 'GET',
    sourceUrl: '',
    authType: '',
    timeoutSec: 30,
    rateLimitLabel: '—',
    checkpointValue: '',
    checkpointUpdatedAt: '',
    checkpointLagLabel: '—',
    recentErrors: [],
    ...partial,
  }
}

describe('streams-console-operations', () => {
  const healthy = row({ id: '1', name: 'Alpha', status: 'RUNNING' })
  const warning = row({ id: '2', name: 'Beta', status: 'DEGRADED', routesError: 1, deliveryPct: 80, deliveryPctKnown: true })
  const critical = row({ id: '3', name: 'Gamma', status: 'ERROR', routesError: 2 })
  const allRows = [healthy, warning, critical]

  it('sorts streams problem-first by severity, issue count, then name', () => {
    const shuffled = [healthy, critical, warning]
    expect(sortStreamsProblemFirst(shuffled).map((r) => r.id)).toEqual(['3', '2', '1'])
    expect(compareStreamsProblemFirst(critical, warning)).toBeLessThan(0)
  })

  it('filters by quick filter issues only', () => {
    const out = filterStreamRows({
      rows: allRows,
      searchQuery: '',
      quickFilter: 'issues',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
    })
    expect(out.map((r) => r.id)).toEqual(['3', '2'])
  })

  it('filters by search across name, product, and destination labels', () => {
    const destMap = new Map<number, string[]>([[2, ['Splunk Prod']]])
    expect(streamMatchesSearch(warning, 'splunk', destMap.get(2)!)).toBe(true)
    expect(streamMatchesSearch(healthy, 'office365', [])).toBe(true)
    const out = filterStreamRows({
      rows: allRows,
      searchQuery: 'gamma',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: destMap,
    })
    expect(out.map((r) => r.id)).toEqual(['3'])
  })

  it('filters by source product group', () => {
    const aws = row({
      id: '4',
      name: 'CloudTrail',
      status: 'RUNNING',
      connectorName: 'AWS',
      connectorProductGroup: 'Amazon Web Services',
    })
    const out = filterStreamRows({
      rows: [...allRows, aws],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'Office365',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
    })
    expect(out.every((r) => r.connectorProductGroup === 'Office365')).toBe(true)
  })

  it('filters by connector query slug', () => {
    const awsCritical = row({
      id: '4',
      name: 'CloudTrail',
      status: 'ERROR',
      connectorId: 11,
      connectorName: 'aws-connector',
      connectorProductGroup: 'Amazon Web Services',
    })
    const out = filterStreamRows({
      rows: [...allRows, awsCritical],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: 'office365 connector',
      destinationLabelsByStreamId: new Map(),
    })
    expect(out.map((r) => r.id)).toEqual(['3', '2', '1'])
  })

  it('filters by connector id query param', () => {
    const out = filterStreamRows({
      rows: allRows,
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: '10',
      destinationLabelsByStreamId: new Map(),
    })
    expect(out.map((r) => r.id)).toEqual(['3', '2', '1'])
  })

  it('filters by operational no-data / low-volume using snapshot stream ids', () => {
    const idle = row({ id: '4', name: 'Idle', status: 'STOPPED', ingestEps: 0, eps1m: 0 })
    const ids = streamIdsMatchingOperationalFilter(
      [
        { stream_id: 1, enabled: true, health_status: 'HEALTHY' },
        { stream_id: 2, enabled: true, health_status: 'DEGRADED' },
        { stream_id: 4, enabled: true, health_status: 'IDLE' },
      ],
      'no-data',
    )
    expect([...ids]).toEqual([4])
    const noData = filterStreamRows({
      rows: [...allRows, idle],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
      operationalFilter: 'no-data',
      operationalFilterStreamIds: ids,
    })
    expect(noData.map((r) => r.id)).toEqual(['4'])

    const lowIds = streamIdsMatchingOperationalFilter(
      [
        { stream_id: 1, enabled: true, health_status: 'HEALTHY' },
        { stream_id: 2, enabled: true, health_status: 'DEGRADED' },
        { stream_id: 4, enabled: true, health_status: 'IDLE' },
      ],
      'low-volume',
    )
    const low = filterStreamRows({
      rows: [...allRows, idle],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
      operationalFilter: 'low-volume',
      operationalFilterStreamIds: lowIds,
    })
    expect(low.map((r) => r.id)).toEqual(['2'])
  })

  it('filters by operational schema-drift using confirmed open counts', () => {
    const withDrift = row({ id: '5', name: 'Drift', status: 'RUNNING', openSchemaFieldDriftCount: 2 })
    const resolvedOnly = row({ id: '6', name: 'Resolved', status: 'RUNNING', openSchemaFieldDriftCount: 0 })
    const ids = streamIdsMatchingOperationalFilter(
      [
        { stream_id: 1, enabled: true, health_status: 'HEALTHY', open_schema_field_drift_count: 0 },
        { stream_id: 5, enabled: true, health_status: 'HEALTHY', open_schema_field_drift_count: 2 },
        { stream_id: 6, enabled: true, health_status: 'HEALTHY', open_schema_field_drift_count: 0 },
      ],
      'schema-drift',
    )
    expect([...ids]).toEqual([5])
    const drifted = filterStreamRows({
      rows: [...allRows, withDrift, resolvedOnly],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
      operationalFilter: 'schema-drift',
      operationalFilterStreamIds: ids,
    })
    expect(drifted.map((r) => r.id)).toEqual(['5'])
    expect(matchesOperationalFilterFallback(withDrift, 'schema-drift')).toBe(true)
    expect(matchesOperationalFilterFallback(resolvedOnly, 'schema-drift')).toBe(false)
  })

  it('falls back to row heuristics when snapshot ids are unavailable', () => {
    const idle = row({ id: '4', name: 'Idle', status: 'STOPPED', ingestEps: 0, eps1m: 0, hasRuntimeApiSnapshot: true })
    const out = filterStreamRows({
      rows: [...allRows, idle],
      searchQuery: '',
      quickFilter: 'all',
      groupFilter: 'all',
      connectorFilter: null,
      destinationLabelsByStreamId: new Map(),
      operationalFilter: 'no-data',
      operationalFilterStreamIds: null,
    })
    expect(out.map((r) => r.id)).toEqual(['4'])
    expect(matchesOperationalFilterFallback(warning, 'low-volume')).toBe(true)
    expect(matchesOperationalFilterFallback(healthy, 'low-volume')).toBe(false)
  })

  it('computes stream operations summary', () => {
    expect(computeStreamOperationsSummary(allRows)).toEqual({
      healthy: 1,
      warning: 1,
      critical: 1,
      issues: 2,
    })
  })

  it('builds problem stream items for warning and critical only', () => {
    const items = buildProblemStreamItems(allRows)
    expect(items.map((i) => i.row.id)).toEqual(['3', '2'])
    expect(items[0]?.severity).toBe('critical')
  })

  it('sorts groups by operational severity: Critical, Stopped, Warning, Healthy', () => {
    const stopped = row({ id: '4', name: 'Delta', status: 'STOPPED' })
    const groups = sortGroupsProblemFirst([
      {
        productLabel: 'HealthyCo',
        rows: [healthy],
        worstStatus: 'RUNNING',
        operationalSeverity: 'healthy',
        issueCount: 0,
        criticalCount: 0,
        warningCount: 0,
        stoppedCount: 0,
        totalEvents: 100,
      },
      {
        productLabel: 'BadCo',
        rows: [critical],
        worstStatus: 'ERROR',
        operationalSeverity: 'critical',
        issueCount: 1,
        criticalCount: 1,
        warningCount: 0,
        stoppedCount: 0,
        totalEvents: 100,
      },
      {
        productLabel: 'WarnCo',
        rows: [warning],
        worstStatus: 'DEGRADED',
        operationalSeverity: 'warning',
        issueCount: 1,
        criticalCount: 0,
        warningCount: 1,
        stoppedCount: 0,
        totalEvents: 100,
      },
      {
        productLabel: 'StoppedCo',
        rows: [stopped],
        worstStatus: 'STOPPED',
        operationalSeverity: 'stopped',
        issueCount: 0,
        criticalCount: 0,
        warningCount: 0,
        stoppedCount: 1,
        totalEvents: 0,
      },
    ])
    expect(groups.map((g) => g.productLabel)).toEqual(['BadCo', 'StoppedCo', 'WarnCo', 'HealthyCo'])
    expect(compareGroupsProblemFirst(groups[0]!, groups[2]!)).toBeLessThan(0)
  })
})
