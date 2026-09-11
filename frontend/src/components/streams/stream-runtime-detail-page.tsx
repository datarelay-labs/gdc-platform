import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Play,
  Radio,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { StreamIssueContext } from '../../lib/stream-issue-context'
import {
  buildIssueWhyChain,
  deriveOperationalIssues,
  fetchStreamGovernanceSnapshot,
  type StreamGovernanceSnapshot,
} from '../../lib/stream-governance-snapshot'
import {
  STREAM_GOVERNANCE_CHANGED_EVENT,
  type StreamGovernanceChangedDetail,
} from '../../lib/stream-governance-events'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  buildStreamExportPath,
  downloadBackupUrl,
  postCloneStream,
} from '../../api/gdcBackup'
import { replayStreamBackfill, type BackfillJobDto } from '../../api/gdcBackfill'
import {
  fetchStreamCheckpointHistory,
  metricsWindowSeconds,
  type MetricsWindow,
  fetchStreamRuntimeMetrics,
  fetchStreamRuntimeStatsHealth,
  fetchStreamRuntimeTimeline,
  invalidateStreamRuntimeReadCache,
  runStreamOnce,
  saveRuntimeRouteEnabledState,
  startRuntimeStream,
  stopRuntimeStream,
} from '../../api/gdcRuntime'
import { fetchConnectorById } from '../../api/gdcConnectors'
import { fetchStreamById } from '../../api/gdcStreams'
import {
  loadRuntimeRefreshEvery,
  persistRuntimeRefreshEvery,
  type RuntimeRefreshEvery,
} from '../../localPreferences'
import { buildRuntimeDetailNumericOverlay, mergeStreamHealthSignals } from '../../api/runtimeHealthAdapter'
import {
  breakdownSlicesFromMetrics,
  chartBucketsFromMetrics,
  eventsSparklineFromMetrics,
  runHistoryFromMetricsRecentRuns,
} from '../../api/runtimeMetricsAdapter'
import { timelineItemsToRecentLogLines, timelineItemsToRunHistoryRows } from '../../api/runtimeTimelineAdapter'
import { formatCheckpointValueForConsole, mapBackendStreamStatus } from '../../api/streamRows'
import { createRefreshCycleSnapshotId, resetRefreshCycleSnapshotId } from '../../api/runtimeSnapshotSync'
import { visualizationSummary } from '../../api/visualizationMeta'
import { cn } from '../../lib/utils'
import { useSessionCapabilities } from '../../lib/rbac'
import { logsExplorerPath, logsPath, NAV_PATH, streamEditPath, streamMappingPath } from '../../config/nav-paths'
import { computeStreamWorkflow } from '../../utils/streamWorkflow'
import { resolveSourceTypePresentation } from '../../utils/sourceTypePresentation'
import { operationalRunControlTooltipSupplement } from '../../utils/streamOperationalBadges'
import { formatRunOnceSummaryLines } from '../../utils/formatRunOnceSummary'
import { RecentRouteErrorsPanel, RouteOperationalPanel } from './route-operational-panel'
import { PipelineDebuggerPanel } from './pipeline-debugger-panel'
import { StreamRuntimeHealthExtension } from './stream-runtime-health-extension'
import { WebhookReceiverRuntimePanel } from './webhook-receiver-runtime-panel'
import { StreamMonitoringStatusStrip } from './stream-monitoring-status-strip'
import { buildFlowTimelineStages, StreamFlowTimeline } from './stream-flow-timeline'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'
import { usePersonaMode } from '../../hooks/use-persona-mode'
import { StreamGovernanceDrawer } from './stream-governance-drawer'
import { SchemaDriftPanel } from './schema-drift-panel'
import { schemaDriftPolicyLabelsFromStreamConfig } from '../../lib/stream-schema-drift-policy'
import { StreamMonitoringObservabilitySection } from './stream-monitoring-observability-section'
import { StreamDetailTabNav, useStreamDetailTab } from './stream-detail-tab-nav'
import { StreamRecentIssuesPanel } from './stream-recent-issues-panel'
import { StreamWhyPanel } from './stream-why-panel'
import { StreamInformationPanel } from './stream-information-panel'
import { formatRelativeShort } from '../../lib/stream-console-metrics'
import { StreamDetailDeliveryPanel } from './stream-detail-delivery-panel'
import { StreamDetailSettingsPanel } from './stream-detail-settings-panel'
import { StreamIssueRail } from './stream-issue-rail'
import { StreamRunControlSwitch } from './stream-run-control-switch'
import { StatusBadge } from '../shell/status-badge'
import { RuntimeChartCard } from '../shell/runtime-chart-card'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import type { RecentLogLine, RunHistoryRow } from './stream-runtime-detail-model'
import { emptyStreamRuntimeDetail } from './stream-runtime-detail-model'
import { useMountAbortController } from '../../hooks/use-mount-abort-signal'
import { isRequestAborted } from '../../lib/request-abort'
import type {
  CheckpointHistoryResponse,
  StreamHealthResponse,
  StreamRead,
  StreamRuntimeMetricsResponse,
  StreamRuntimeStatsResponse,
} from '../../api/types/gdcApi'
import type { StreamRuntimeStatus } from '../../api/streamRows'

function statusTone(s: StreamRuntimeStatus) {
  switch (s) {
    case 'RUNNING':
      return 'success' as const
    case 'DEGRADED':
      return 'warning' as const
    case 'ERROR':
      return 'error' as const
    case 'STOPPED':
      return 'neutral' as const
    case 'UNKNOWN':
      return 'neutral' as const
    default: {
      const _e: never = s
      return _e
    }
  }
}

export function StreamRuntimeDetailPage() {
  const { streamId = '' } = useParams<{ streamId: string }>()
  const activeTab = useStreamDetailTab()
  const navigate = useNavigate()
  const { isGovernance } = usePersonaMode()
  const data = useMemo(() => emptyStreamRuntimeDetail(streamId), [streamId])
  const [timelineRunHistory, setTimelineRunHistory] = useState<RunHistoryRow[] | null>(null)
  const [timelineRecentLogs, setTimelineRecentLogs] = useState<RecentLogLine[] | null>(null)
  const [timelineRunIdHint, setTimelineRunIdHint] = useState<string | null>(null)
  const [runtimeStats, setRuntimeStats] = useState<StreamRuntimeStatsResponse | null>(null)
  const [runtimeHealth, setRuntimeHealth] = useState<StreamHealthResponse | null>(null)
  const [controlBusy, setControlBusy] = useState(false)
  const [routeToggleBusyId, setRouteToggleBusyId] = useState<number | null>(null)
  const [controlMessage, setControlMessage] = useState<string | null>(null)
  const [runOnceBusy, setRunOnceBusy] = useState(false)
  const [runOnceLines, setRunOnceLines] = useState<string[] | null>(null)
  const [runOnceError, setRunOnceError] = useState<string | null>(null)
  const [streamEntity, setStreamEntity] = useState<StreamRead | null>(null)
  const [streamMetaReady, setStreamMetaReady] = useState(false)
  const [streamMetaError, setStreamMetaError] = useState<string | null>(null)
  const [connectorProductGroup, setConnectorProductGroup] = useState<string | null>(null)
  const [connectorDisplayName, setConnectorDisplayName] = useState<string | null>(null)
  const [runtimeMetrics, setRuntimeMetrics] = useState<StreamRuntimeMetricsResponse | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const metricsGenerationRef = useRef(0)
  const runtimeDataGenerationRef = useRef(0)
  const governanceGenRef = useRef(0)
  const streamMetaGenRef = useRef(0)
  const connectorMetaGenRef = useRef(0)
  const checkpointGenRef = useRef(0)
  const abortRef = useMountAbortController()
  const mountedRef = useRef(true)
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('1h')
  const [refreshEvery, setRefreshEvery] = useState<RuntimeRefreshEvery>('off')
  useLayoutEffect(() => {
    setRefreshEvery(loadRuntimeRefreshEvery())
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runtimeDataGenerationRef.current += 1
      metricsGenerationRef.current += 1
    }
  }, [])
  const [checkpointHistory, setCheckpointHistory] = useState<CheckpointHistoryResponse | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [bfStart, setBfStart] = useState('')
  const [bfEnd, setBfEnd] = useState('')
  const [bfDryRun, setBfDryRun] = useState(false)
  const [bfBusy, setBfBusy] = useState(false)
  const [bfResult, setBfResult] = useState<BackfillJobDto | null>(null)
  const [bfLastWasDryRun, setBfLastWasDryRun] = useState<boolean | null>(null)
  const [bfError, setBfError] = useState<string | null>(null)
  const [observabilityOpen, setObservabilityOpen] = useState(false)
  const [governanceSnapshot, setGovernanceSnapshot] = useState<StreamGovernanceSnapshot | null>(null)

  const caps = useSessionCapabilities()
  const canRuntimeControl = caps.runtime_stream_control === true
  const canMutateWorkspace = caps.workspace_mutations === true
  const canBackfill = caps.backfill_mutations === true
  const canClone = caps.backup_clone === true

  const backendStreamId = useMemo(() => (/^\d+$/.test(streamId) ? Number(streamId) : undefined), [streamId])

  const logsExplorerDrilldown = useMemo(() => {
    if (backendStreamId == null) return null
    return logsExplorerPath({
      stream_id: backendStreamId,
      run_id: timelineRunIdHint ?? undefined,
    })
  }, [backendStreamId, timelineRunIdHint])

  useEffect(() => {
    if (!backfillOpen || backendStreamId == null) return
    const end = new Date()
    const start = new Date(end.getTime() - 14 * 86400000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    setBfStart(fmt(start))
    setBfEnd(fmt(end))
    setBfResult(null)
    setBfError(null)
    setBfLastWasDryRun(null)
  }, [backfillOpen, backendStreamId])

  useEffect(() => {
    if (backendStreamId == null) {
      setStreamEntity(null)
      setStreamMetaReady(true)
      setStreamMetaError(
        streamId.trim() !== '' && !/^\d+$/.test(streamId)
          ? `Invalid stream id "${streamId}". Open a stream from the Streams list.`
          : null,
      )
      return
    }
    setStreamMetaReady(false)
    setStreamMetaError(null)
    const gen = ++streamMetaGenRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    ;(async () => {
      try {
        const s = await fetchStreamById(backendStreamId, fetchOpts)
        if (gen !== streamMetaGenRef.current) return
        if (s == null) {
          setStreamEntity(null)
          setStreamMetaError(`Stream #${backendStreamId} was not found or could not be loaded.`)
        } else {
          setStreamEntity(s)
          setStreamMetaError(null)
        }
        setStreamMetaReady(true)
      } catch (e) {
        if (isRequestAborted(e)) return
        if (gen !== streamMetaGenRef.current) return
        setStreamEntity(null)
        setStreamMetaError(e instanceof Error ? e.message : 'Failed to load stream metadata.')
        setStreamMetaReady(true)
      }
    })()
  }, [backendStreamId, streamId, abortRef])

  useEffect(() => {
    const cid = streamEntity?.connector_id
    if (cid == null || !Number.isFinite(cid)) {
      setConnectorProductGroup(null)
      setConnectorDisplayName(null)
      return
    }
    const gen = ++connectorMetaGenRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    ;(async () => {
      try {
        const c = await fetchConnectorById(cid, fetchOpts)
        if (gen !== connectorMetaGenRef.current) return
        setConnectorDisplayName((c?.name ?? '').trim() || null)
        setConnectorProductGroup((c?.product_group ?? '').trim() || null)
      } catch (e) {
        if (isRequestAborted(e)) return
      }
    })()
  }, [streamEntity?.connector_id, abortRef])

  const loadRuntimeMetrics = useCallback(async (reuseSnapshotId?: string) => {
    const token = ++metricsGenerationRef.current
    // Invalidate concurrent full-refresh metrics commits that share setRuntimeMetrics.
    runtimeDataGenerationRef.current += 1
    const isCurrent = () => mountedRef.current && token === metricsGenerationRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    if (backendStreamId == null) {
      if (!mountedRef.current) return
      setRuntimeMetrics(null)
      setMetricsError(null)
      return
    }
    if (!mountedRef.current) return
    setMetricsLoading(true)
    setMetricsError(null)
    const snapshot_id = reuseSnapshotId?.trim() || createRefreshCycleSnapshotId()
    try {
      const m = await fetchStreamRuntimeMetrics(backendStreamId, metricsWindow, { snapshot_id }, fetchOpts)
      if (!isCurrent()) return
      if (m) {
        setRuntimeMetrics(m)
      } else {
        setMetricsError('Metrics API unavailable')
      }
    } catch (e) {
      if (isRequestAborted(e)) return
      if (!isCurrent()) return
      setMetricsError(e instanceof Error ? e.message : 'Metrics API unavailable')
    } finally {
      if (isCurrent()) setMetricsLoading(false)
    }
  }, [backendStreamId, metricsWindow, abortRef])

  const loadGovernanceSnapshot = useCallback(async () => {
    if (backendStreamId == null) {
      setGovernanceSnapshot(null)
      return
    }
    const gen = ++governanceGenRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    try {
      const gov = await fetchStreamGovernanceSnapshot(backendStreamId, fetchOpts)
      if (gen !== governanceGenRef.current) return
      setGovernanceSnapshot(gov)
    } catch (e) {
      if (isRequestAborted(e)) return
      if (gen !== governanceGenRef.current) return
      /* optional enrichment — overview stays usable without governance summaries */
    }
  }, [backendStreamId, abortRef])

  const loadCheckpointHistory = useCallback(async () => {
    if (backendStreamId == null) {
      setCheckpointHistory(null)
      return
    }
    const showCheckpoint = resolveSourceTypePresentation(streamEntity?.stream_type).runtime.showCheckpointObservability
    if (!showCheckpoint) {
      setCheckpointHistory(null)
      return
    }
    const gen = ++checkpointGenRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    try {
      const chk = await fetchStreamCheckpointHistory(backendStreamId, 14, fetchOpts)
      if (!mountedRef.current || gen !== checkpointGenRef.current) return
      setCheckpointHistory(chk)
    } catch (e) {
      if (isRequestAborted(e)) return
      if (gen !== checkpointGenRef.current) return
    }
  }, [backendStreamId, streamEntity?.stream_type, abortRef])

  const refreshRuntimeData = useCallback(async () => {
    const token = ++runtimeDataGenerationRef.current
    // Invalidate concurrent window-only metrics loads that share setRuntimeMetrics.
    metricsGenerationRef.current += 1
    const isCurrent = () => mountedRef.current && token === runtimeDataGenerationRef.current
    const fetchOpts = { signal: abortRef.current?.signal }
    if (backendStreamId == null) {
      if (!mountedRef.current) return false
      setTimelineRunHistory(null)
      setTimelineRecentLogs(null)
      setTimelineRunIdHint(null)
      setRuntimeStats(null)
      setRuntimeHealth(null)
      setCheckpointHistory(null)
      setGovernanceSnapshot(null)
      return false
    }
    const snapshot_id = createRefreshCycleSnapshotId()
    if (!mountedRef.current) return false
    setMetricsLoading(true)
    setMetricsError(null)
    const metricsPromise = fetchStreamRuntimeMetrics(
      backendStreamId,
      metricsWindow,
      { snapshot_id },
      fetchOpts,
    )
    try {
      const [res, statsHealth] = await Promise.all([
        fetchStreamRuntimeTimeline(backendStreamId, { limit: 80, signal: fetchOpts.signal }),
        fetchStreamRuntimeStatsHealth(backendStreamId, 120, metricsWindow, { snapshot_id }, fetchOpts),
      ])
      if (!isCurrent()) return false
      if (res?.items?.length) {
        const items = res.items
        const last = items[items.length - 1]
        const rid = typeof last.run_id === 'string' && last.run_id.trim() !== '' ? last.run_id : null
        setTimelineRunIdHint(rid)
        setTimelineRunHistory(timelineItemsToRunHistoryRows(items))
        setTimelineRecentLogs(timelineItemsToRecentLogLines(items, 14))
      } else {
        setTimelineRunHistory(null)
        setTimelineRecentLogs(null)
        setTimelineRunIdHint(null)
      }
      setRuntimeStats(statsHealth?.stats ?? null)
      setRuntimeHealth(statsHealth?.health ?? null)
      void metricsPromise
        .then((metrics) => {
          if (!isCurrent()) return
          if (metrics) {
            setRuntimeMetrics(metrics)
            setMetricsError(null)
          } else {
            setMetricsError('Metrics API unavailable')
          }
        })
        .catch((e) => {
          if (isRequestAborted(e)) return
          if (!isCurrent()) return
          setMetricsError(e instanceof Error ? e.message : 'Metrics API unavailable')
        })
        .finally(() => {
          if (isCurrent()) setMetricsLoading(false)
        })
      return true
    } catch (e) {
      if (isRequestAborted(e)) return false
      void metricsPromise.finally(() => {
        if (isCurrent()) setMetricsLoading(false)
      })
      throw e
    }
  }, [backendStreamId, metricsWindow, abortRef])

  /** Manual Refresh: runtime + governance. Auto-poll must not use this. */
  const refreshRuntimeDataWithEnrichment = useCallback(async () => {
    const ok = await refreshRuntimeData()
    if (ok) {
      void loadGovernanceSnapshot()
    }
    return ok
  }, [refreshRuntimeData, loadGovernanceSnapshot])

  /** Runtime control mutations: refresh operational data only (not governance summaries). */
  const refreshAfterMutation = useCallback(async () => {
    if (backendStreamId != null) {
      invalidateStreamRuntimeReadCache(backendStreamId)
      resetRefreshCycleSnapshotId()
    }
    return refreshRuntimeData()
  }, [backendStreamId, refreshRuntimeData])

  useEffect(() => {
    if (backendStreamId == null || !streamMetaReady) return
    let cancelled = false
    void refreshRuntimeData()
      .then((ok) => {
        if (cancelled || !ok) return
        void loadGovernanceSnapshot()
      })
      .catch((e) => {
        if (isRequestAborted(e)) return
        if (import.meta.env.DEV) console.error('[stream runtime] refresh failed', e)
      })
    return () => {
      cancelled = true
      checkpointGenRef.current += 1
    }
  }, [backendStreamId, streamMetaReady, refreshRuntimeData, loadGovernanceSnapshot])

  useEffect(() => {
    if (backendStreamId == null) return
    const onGovernanceChanged = (event: Event) => {
      const detail = (event as CustomEvent<StreamGovernanceChangedDetail>).detail
      if (detail?.streamId !== backendStreamId) return
      void loadGovernanceSnapshot()
    }
    window.addEventListener(STREAM_GOVERNANCE_CHANGED_EVENT, onGovernanceChanged)
    return () => window.removeEventListener(STREAM_GOVERNANCE_CHANGED_EVENT, onGovernanceChanged)
  }, [backendStreamId, loadGovernanceSnapshot])

  useEffect(() => {
    if (activeTab !== 'audit' || backendStreamId == null || !streamMetaReady) return
    void loadCheckpointHistory()
  }, [activeTab, backendStreamId, streamMetaReady, loadCheckpointHistory])

  const showMetricsControls = activeTab === 'overview' || activeTab === 'metrics'

  useEffect(() => {
    if (!showMetricsControls || refreshEvery === 'off' || backendStreamId == null) {
      return
    }
    const ms = refreshEvery === '10s' ? 10_000 : refreshEvery === '30s' ? 30_000 : refreshEvery === '1m' ? 60_000 : 0
    if (!ms) return
    const t = window.setInterval(() => {
      if (!mountedRef.current || abortRef.current?.signal.aborted) return
      // Runtime-only: governance summaries are not polled on the auto-refresh cadence.
      void refreshRuntimeData()
    }, ms)
    return () => window.clearInterval(t)
  }, [showMetricsControls, refreshEvery, backendStreamId, refreshRuntimeData, abortRef])

  const runStreamControl = useCallback(
    async (action: 'start' | 'stop') => {
      if (!canRuntimeControl || backendStreamId == null || controlBusy || runOnceBusy) return
      setControlBusy(true)
      setControlMessage(null)
      const res = action === 'start' ? await startRuntimeStream(backendStreamId) : await stopRuntimeStream(backendStreamId)
      if (!mountedRef.current) return
      if (res) {
        await refreshAfterMutation()
        if (activeTab === 'audit') void loadCheckpointHistory()
        if (!mountedRef.current) return
        window.dispatchEvent(new CustomEvent('gdc-runtime-control-updated', { detail: { streamId: backendStreamId, action } }))
        setControlMessage(res.message)
      } else {
        setControlMessage('Runtime API unavailable · control action not applied.')
      }
      setControlBusy(false)
    },
    [backendStreamId, canRuntimeControl, controlBusy, refreshAfterMutation, runOnceBusy, activeTab, loadCheckpointHistory],
  )

  const executeRunOnce = useCallback(async () => {
    if (!canRuntimeControl || backendStreamId == null || runOnceBusy || controlBusy) return
    setRunOnceBusy(true)
    setRunOnceLines(null)
    setRunOnceError(null)
    setControlMessage(null)
    try {
      const r = await runStreamOnce(backendStreamId)
      if (!mountedRef.current) return
      setRunOnceLines(formatRunOnceSummaryLines(r))
      await refreshAfterMutation()
      if (activeTab === 'audit') void loadCheckpointHistory()
      if (!mountedRef.current) return
      window.dispatchEvent(new CustomEvent('gdc-runtime-run-once', { detail: { streamId: backendStreamId, response: r } }))
    } catch (e) {
      if (mountedRef.current) setRunOnceError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mountedRef.current) setRunOnceBusy(false)
    }
  }, [backendStreamId, canRuntimeControl, runOnceBusy, controlBusy, refreshAfterMutation, activeTab, loadCheckpointHistory])

  const executeBackfill = useCallback(async () => {
    if (!canBackfill || backendStreamId == null || bfBusy) return
    setBfBusy(true)
    setBfError(null)
    setBfResult(null)
    setBfLastWasDryRun(null)
    try {
      const job = await replayStreamBackfill({
        stream_id: backendStreamId,
        start_time: new Date(bfStart).toISOString(),
        end_time: new Date(bfEnd).toISOString(),
        dry_run: bfDryRun,
      })
      setBfResult(job)
      setBfLastWasDryRun(bfDryRun)
    } catch (e) {
      setBfError(e instanceof Error ? e.message : String(e))
    } finally {
      setBfBusy(false)
    }
  }, [backendStreamId, bfBusy, bfDryRun, bfEnd, bfStart, canBackfill])

  const onExportStreamBackup = useCallback(async () => {
    if (backendStreamId == null) return
    setBackupBusy(true)
    setBackupMsg(null)
    try {
      const url = buildStreamExportPath(backendStreamId, { include_destinations: true })
      await downloadBackupUrl(url, `stream-${backendStreamId}-export.json`)
      setBackupMsg('Export downloaded.')
    } catch (e) {
      setBackupMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBackupBusy(false)
    }
  }, [backendStreamId])

  const onCloneStreamBackup = useCallback(async () => {
    if (!canClone || backendStreamId == null) return
    setBackupBusy(true)
    setBackupMsg(null)
    try {
      const r = await postCloneStream(backendStreamId)
      navigate(r.redirect_path)
    } catch (e) {
      setBackupMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBackupBusy(false)
    }
  }, [backendStreamId, canClone, navigate])

  const onToggleRouteEnabled = useCallback(
    async (routeId: number, nextEnabled: boolean, opts?: { disable_reason?: string | null }) => {
      if (!canRuntimeControl || routeToggleBusyId != null) return
      setRouteToggleBusyId(routeId)
      setControlMessage(null)
      const res = await saveRuntimeRouteEnabledState(
        routeId,
        nextEnabled,
        !nextEnabled ? { disable_reason: opts?.disable_reason ?? undefined } : undefined,
      )
      if (!mountedRef.current) return
      if (res) {
        await refreshAfterMutation()
        if (activeTab === 'audit') void loadCheckpointHistory()
        if (!mountedRef.current) return
        window.dispatchEvent(
          new CustomEvent('gdc-runtime-control-updated', {
            detail: { streamId: backendStreamId, routeId, routeEnabled: nextEnabled },
          }),
        )
        setControlMessage(res.message)
      } else {
        setControlMessage('Runtime API unavailable · route state unchanged.')
      }
      setRouteToggleBusyId(null)
    },
    [backendStreamId, canRuntimeControl, refreshAfterMutation, routeToggleBusyId, activeTab, loadCheckpointHistory],
  )

  const recentLogLines = timelineRecentLogs ?? []

  const displayStatus: StreamRuntimeStatus = useMemo(() => {
    if (runtimeMetrics?.stream?.status) return mapBackendStreamStatus(runtimeMetrics.stream.status)
    if (runtimeStats) return mapBackendStreamStatus(runtimeStats.stream_status)
    if (runtimeHealth) return mapBackendStreamStatus(runtimeHealth.stream_status)
    return 'UNKNOWN'
  }, [runtimeMetrics, runtimeStats, runtimeHealth])

  const numericOverlay = useMemo(
    () => buildRuntimeDetailNumericOverlay(runtimeStats, runtimeHealth, runtimeMetrics),
    [runtimeStats, runtimeHealth, runtimeMetrics],
  )

  const events1h = numericOverlay.events1h
  const eventsSparkline = useMemo(() => {
    if (runtimeMetrics) return [...eventsSparklineFromMetrics(runtimeMetrics)]
    if (numericOverlay.events1h == null) return [0, 0, 0, 0, 0, 0, 0]
    const v = numericOverlay.events1h
    return [v, v, v, v, v, v, v]
  }, [runtimeMetrics, numericOverlay.events1h])

  const deliveryPct = numericOverlay.deliveryPct
  const deliveryLabel = numericOverlay.deliveryLabel

  const routesTotal = numericOverlay.routesTotal
  const routesOk = numericOverlay.routesOk
  const routesErr = numericOverlay.routesErr

  const streamHealthSignals = useMemo(
    () => mergeStreamHealthSignals(data.streamHealthSignals, runtimeStats, runtimeHealth, runtimeMetrics),
    [data.streamHealthSignals, runtimeStats, runtimeHealth, runtimeMetrics],
  )

  const eventsOverChartData = useMemo(() => {
    const fromApi = chartBucketsFromMetrics(runtimeMetrics)
    if (fromApi.length > 0) return fromApi
    return [...data.eventsOverTime]
  }, [runtimeMetrics, data.eventsOverTime])

  const eventsBreakdownData = useMemo(() => {
    const fromApi = breakdownSlicesFromMetrics(runtimeMetrics)
    if (fromApi.length > 0) return fromApi
    return [...data.eventsBreakdown]
  }, [runtimeMetrics, data.eventsBreakdown])

  const runHistoryRows = useMemo(() => {
    const fromMetrics = runHistoryFromMetricsRecentRuns(runtimeMetrics)
    if (fromMetrics.length > 0) return fromMetrics
    return timelineRunHistory ?? []
  }, [runtimeMetrics, timelineRunHistory])

  const hasRuntimeObsApi = runtimeStats != null || runtimeHealth != null || runtimeMetrics != null

  const runtimeWorkflow = useMemo(
    () =>
      computeStreamWorkflow({
        streamId,
        status: displayStatus,
        events1h: events1h ?? 0,
        deliveryPct: deliveryPct ?? 0,
        routesTotal: routesTotal ?? 0,
        routesOk: routesOk ?? 0,
        routesError: routesErr ?? 0,
        hasConnector: true,
        sourceType: streamEntity?.stream_type ?? null,
      }),
    [streamId, displayStatus, events1h, deliveryPct, routesTotal, routesOk, routesErr, streamEntity?.stream_type],
  )

  const donutTotal = useMemo(() => eventsBreakdownData.reduce((s, x) => s + x.value, 0), [eventsBreakdownData])

  const routeRetryTotalLastHour = useMemo(() => {
    const rr = runtimeMetrics?.route_runtime
    if (!rr?.length) return null
    const n = rr.reduce((acc, r) => acc + (Number.isFinite(r.retry_count_last_hour) ? r.retry_count_last_hour : 0), 0)
    return n
  }, [runtimeMetrics?.route_runtime])

  const metricsChartsEmpty = useMemo(() => {
    if (!runtimeMetrics) return false
    const sum = eventsOverChartData.reduce((s, b) => s + b.ingested + b.delivered + b.failed, 0)
    return sum === 0
  }, [runtimeMetrics, eventsOverChartData])
  const eventsOverTimeSemantics = visualizationSummary(
    runtimeMetrics?.visualization_meta,
    'stream.processed_events.bucket_count',
  )
  const failedLastHour = runtimeMetrics?.kpis.failed_last_hour ?? null
  const errorRate = runtimeMetrics?.kpis.error_rate ?? null
  const lastErrorAt = runtimeMetrics?.stream.last_error_at ?? null

  const runtimeSourceUi = useMemo(
    () => resolveSourceTypePresentation(streamEntity?.stream_type),
    [streamEntity?.stream_type],
  )

  const flowTimelineStages = useMemo(
    () =>
      buildFlowTimelineStages({
        streamId,
        displayStatus,
        workflow: runtimeWorkflow,
        deliveryPct,
        deliveredLastHour: runtimeMetrics?.kpis.delivered_last_hour ?? null,
        failedLastHour: runtimeMetrics?.kpis.failed_last_hour ?? null,
        routesErr,
        usesPushIngest: runtimeSourceUi.runtime.usesPushIngest,
        governance: governanceSnapshot,
      }),
    [streamId, displayStatus, runtimeWorkflow, deliveryPct, runtimeMetrics, routesErr, runtimeSourceUi.runtime.usesPushIngest, governanceSnapshot],
  )

  const lastRunLabel = useMemo(() => {
    const at = runtimeMetrics?.stream.last_run_at ?? null
    if (!at) return null
    const diff = Date.now() - new Date(at).getTime()
    if (!Number.isFinite(diff) || diff < 0) return at.slice(0, 19).replace('T', ' ')
    const sec = Math.round(diff / 1000)
    if (sec < 60) return `${sec}s ago`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.round(min / 60)
    return `${hr}h ago`
  }, [runtimeMetrics?.stream.last_run_at])

  const monitoringWindowSeconds = useMemo(
    () => runtimeMetrics?.metrics_window_seconds ?? metricsWindowSeconds(metricsWindow),
    [runtimeMetrics?.metrics_window_seconds, metricsWindow],
  )

  const issueCtx = useMemo((): StreamIssueContext => {
    const recentErrors = (runtimeMetrics?.recent_route_errors ?? [])
      .slice(0, 3)
      .map((e) => ({ message: e.message ?? 'Delivery path error' }))
    const lastAt =
      runtimeMetrics?.stream.last_run_at ??
      runtimeMetrics?.stream.last_success_at ??
      runtimeMetrics?.stream.last_error_at ??
      runtimeStats?.last_seen?.success_at ??
      runtimeStats?.last_seen?.failure_at ??
      null
    let lastActivityRelative = data.lastUpdatedRelative
    if (lastAt) {
      const diff = Date.now() - new Date(lastAt).getTime()
      if (Number.isFinite(diff) && diff >= 0) {
        const sec = Math.round(diff / 1000)
        if (sec < 60) lastActivityRelative = `${sec}s ago`
        else if (sec < 3600) lastActivityRelative = `${Math.round(sec / 60)}m ago`
        else lastActivityRelative = `${Math.round(sec / 3600)}h ago`
      }
    }
    return {
      id: streamId,
      status: displayStatus,
      connectorName: connectorDisplayName ?? data.connectorName,
      connectorProductGroup,
      deliveryPctKnown: deliveryPct != null,
      deliveryPct: deliveryPct ?? 0,
      routesError: routesErr ?? 0,
      lastActivityRelative,
      recentErrors,
    }
  }, [
    runtimeMetrics,
    runtimeStats,
    streamId,
    displayStatus,
    connectorDisplayName,
    connectorProductGroup,
    data.connectorName,
    data.lastUpdatedRelative,
    deliveryPct,
    routesErr,
  ])

  const operationalIssues = useMemo(
    () => deriveOperationalIssues(issueCtx, governanceSnapshot),
    [issueCtx, governanceSnapshot],
  )

  const issueWhyChain = useMemo(
    () => buildIssueWhyChain(operationalIssues, issueCtx, governanceSnapshot),
    [operationalIssues, issueCtx, governanceSnapshot],
  )

  const showCheckpointObservability = runtimeSourceUi.runtime.showCheckpointObservability
  const schemaDriftPolicyLabels = useMemo(
    () => schemaDriftPolicyLabelsFromStreamConfig(streamEntity?.config_json),
    [streamEntity?.config_json],
  )

  const runControlTooltipExtra = operationalRunControlTooltipSupplement(streamEntity?.name)

  const streamDisplayName = (streamEntity?.name ?? '').trim() || data.name

  const lastRunDisplay = useMemo(() => {
    const at = runtimeMetrics?.stream.last_run_at ?? null
    if (!at) return null
    return formatRelativeShort(at)
  }, [runtimeMetrics?.stream.last_run_at])

  const nextRunDisplay = useMemo(() => {
    if (displayStatus !== 'RUNNING') return null
    const lastAt = runtimeMetrics?.stream.last_run_at
    const intervalSec = streamEntity?.polling_interval
    if (!lastAt || typeof intervalSec !== 'number' || !Number.isFinite(intervalSec) || intervalSec <= 0) return null
    const next = new Date(Date.parse(lastAt) + intervalSec * 1000)
    if (!Number.isFinite(next.getTime())) return null
    if (next.getTime() <= Date.now()) return 'Now'
    return next.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }, [displayStatus, runtimeMetrics?.stream.last_run_at, streamEntity?.polling_interval])

  const schemaVersionDisplay = useMemo(() => {
    const drift = governanceSnapshot?.schemaDrift
    if (!drift) return null
    const total = (drift.open_count ?? 0) + (drift.acknowledged_count ?? 0) + (drift.resolved_count ?? 0)
    if (total <= 0) return null
    return `v${total}`
  }, [governanceSnapshot?.schemaDrift])

  const checkpointDisplay = useMemo(() => {
    const cp = runtimeMetrics?.stream.last_checkpoint
    if (!cp) return null
    const preview = formatCheckpointValueForConsole(cp.value)
    return preview !== '—' ? preview : cp.type || null
  }, [runtimeMetrics?.stream.last_checkpoint])

  if (backendStreamId != null && !streamMetaReady) {
    return (
      <div
        className="flex min-h-[12rem] items-center justify-center gap-2 text-[13px] text-slate-600 dark:text-gdc-muted"
        role="status"
        data-testid="stream-runtime-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading stream…
      </div>
    )
  }

  if (streamMetaError != null || (backendStreamId != null && streamMetaReady && streamEntity == null)) {
    return (
      <section
        className="rounded-xl border border-red-200/90 bg-red-50/80 px-4 py-5 dark:border-red-500/35 dark:bg-red-500/10"
        role="alert"
        data-testid="stream-runtime-load-error"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          <div>
            <h2 className="text-[15px] font-semibold text-red-950 dark:text-red-100">Stream unavailable</h2>
            <p className="mt-1 text-[13px] text-red-900 dark:text-red-200">
              {streamMetaError ?? `Stream #${backendStreamId ?? streamId} could not be loaded.`}
            </p>
            <Link
              to={NAV_PATH.streams}
              className="mt-3 inline-flex text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              Back to Streams
            </Link>
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      {!canRuntimeControl ? (
        <p
          role="status"
          className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/95"
        >
          Read-only monitoring session: stream start/stop, Run Now, route toggles, and backfill controls are hidden. Metrics, charts, and log
          links remain available.
        </p>
      ) : null}
      <nav aria-label="Breadcrumb" className="text-[12px] text-slate-500 dark:text-gdc-muted">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to={NAV_PATH.streams} className="hover:text-violet-600 dark:hover:text-violet-400">
              Streams
            </Link>
          </li>
          <li aria-hidden className="text-slate-400">›</li>
          <li className="text-slate-600 dark:text-gdc-mutedStrong">{connectorProductGroup ?? connectorDisplayName ?? 'Source'}</li>
          <li aria-hidden className="text-slate-400">›</li>
          <li className="font-medium text-slate-800 dark:text-slate-200">{(streamEntity?.name ?? '').trim() || data.name}</li>
        </ol>
      </nav>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Stream monitoring</h2>
          <p className="mt-0.5 text-[13px] font-medium text-slate-600 dark:text-gdc-mutedStrong">{streamDisplayName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={statusTone(displayStatus)} className="font-bold uppercase tracking-wide">
            {displayStatus}
          </StatusBadge>
        </div>
      </div>

      <StreamDetailTabNav streamId={streamId} active={activeTab} />

      {(activeTab === 'overview' || activeTab === 'audit') ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/80 pb-3 dark:border-gdc-border">
          {canMutateWorkspace ? (
            <Link
              to={streamEditPath(streamId)}
              className="inline-flex h-8 items-center rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
            >
              Edit
            </Link>
          ) : (
            <span
              className="inline-flex h-8 cursor-not-allowed items-center rounded-md border border-slate-200/60 bg-slate-50 px-2.5 text-[12px] font-semibold text-slate-400 dark:border-gdc-border/60 dark:bg-gdc-section dark:text-slate-500"
              title="Viewer role cannot edit stream configuration."
            >
              Edit
            </span>
          )}
          <span className="inline-flex h-8 items-center rounded-md border border-violet-300/80 bg-violet-500/[0.12] px-2.5 text-[12px] font-semibold text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-100">
            Stream monitoring
          </span>
          {backendStreamId != null && canRuntimeControl ? (
            <StreamRunControlSwitch
              status={displayStatus}
              busy={controlBusy}
              disabled={runOnceBusy}
              size="sm"
              tooltipExtra={runControlTooltipExtra ?? undefined}
              onToggle={(nextActive) => void runStreamControl(nextActive ? 'start' : 'stop')}
            />
          ) : null}
          {canRuntimeControl ? (
            <button
              type="button"
              disabled={backendStreamId == null || runOnceBusy || controlBusy}
              title={
                runControlTooltipExtra
                  ? `Run the full pipeline once (saved config). ${runControlTooltipExtra}`
                  : 'Run the full extract → map → enrich → deliver pipeline once.'
              }
              onClick={() => void executeRunOnce()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {runOnceBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {runOnceBusy ? 'Running…' : 'Run Now'}
            </button>
          ) : null}
          {canBackfill ? (
            <button
              type="button"
              data-testid="stream-run-backfill-open"
              disabled={backendStreamId == null || bfBusy || runOnceBusy || controlBusy}
              onClick={() => setBackfillOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-200/90 bg-amber-500/[0.08] px-2.5 text-[12px] font-semibold text-amber-900 hover:bg-amber-500/[0.14] disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20"
            >
              <History className="h-3.5 w-3.5" aria-hidden />
              Run Backfill
            </button>
          ) : null}
          {backendStreamId != null ? (
            <>
              <button
                type="button"
                disabled={backupBusy || runOnceBusy || controlBusy}
                onClick={() => void onExportStreamBackup()}
                className="inline-flex h-8 items-center rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                {backupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                Export JSON
              </button>
              <button
                type="button"
                disabled={backupBusy || runOnceBusy || controlBusy || !canClone}
                onClick={() => void onCloneStreamBackup()}
                className="inline-flex h-8 items-center rounded-md border border-violet-200/90 bg-violet-500/[0.08] px-2.5 text-[12px] font-semibold text-violet-900 hover:bg-violet-500/[0.14] disabled:cursor-not-allowed disabled:opacity-60 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100 dark:hover:bg-violet-500/20"
              >
                Clone stream
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {showMetricsControls ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/80 pb-3 dark:border-gdc-border">
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            <span className="shrink-0">Time range</span>
            <select
              value={metricsWindow}
              onChange={(e) => setMetricsWindow(e.target.value as MetricsWindow)}
              className="rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[12px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              aria-label="Runtime metrics time range"
              data-testid="stream-runtime-time-range"
            >
              <option value="15m">Last 15m</option>
              <option value="1h">Last 1h</option>
              <option value="6h">Last 6h</option>
              <option value="24h">Last 24h</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
            <span className="shrink-0">Auto refresh</span>
            <select
              value={refreshEvery}
              onChange={(e) => {
                const next = e.target.value as RuntimeRefreshEvery
                setRefreshEvery(next)
                persistRuntimeRefreshEvery(next)
              }}
              className="rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[12px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              aria-label="Runtime auto refresh interval"
              data-testid="stream-runtime-auto-refresh"
            >
              <option value="off">Off</option>
              <option value="10s">10s</option>
              <option value="30s">30s</option>
              <option value="1m">1m</option>
            </select>
          </label>
          <button
            type="button"
            disabled={backendStreamId == null || metricsLoading}
            onClick={() => void refreshRuntimeDataWithEnrichment()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
            data-testid="stream-runtime-refresh-now"
          >
            {metricsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Refresh
          </button>
        </div>
      ) : null}
      {controlMessage ? <p className="text-[11px] font-medium text-slate-600 dark:text-gdc-mutedStrong">{controlMessage}</p> : null}
      {backupMsg ? (
        <p
          className={cn(
            'text-[11px] font-medium',
            backupMsg.startsWith('Export downloaded') ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300',
          )}
          role={backupMsg.startsWith('Export downloaded') ? undefined : 'alert'}
        >
          {backupMsg}
        </p>
      ) : null}
      {runOnceError ? (
        <p className="text-[11px] font-medium text-red-700 dark:text-red-300" role="alert">
          {runOnceError}
        </p>
      ) : null}
      {metricsError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span>{metricsError}</span>
          <button
            type="button"
            className="rounded-md border border-amber-400/80 bg-white px-2 py-1 text-[11px] font-semibold text-amber-950 hover:bg-amber-50 dark:border-amber-500/50 dark:bg-gdc-card dark:text-amber-100 dark:hover:bg-gdc-rowHover"
            onClick={() => void loadRuntimeMetrics()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {runOnceLines?.length ? (
        <div
          role="status"
          className="rounded-md border border-emerald-300/70 bg-emerald-500/[0.06] px-2 py-1.5 text-[11px] text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
        >
          <p className="font-semibold">Latest run once</p>
          <ul className="mt-0.5 list-inside list-disc space-y-0.5">
            {runOnceLines.map((line, i) => (
              <li key={`run-once-${i}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="min-w-0 flex-1 space-y-4">
      {activeTab === 'violations' ? (
        <StreamIssueRail
          ctx={issueCtx}
          numericId={backendStreamId}
          controlBusy={controlBusy}
          runOnceBusy={runOnceBusy}
          onRunOnce={() => void executeRunOnce()}
          onStop={() => void runStreamControl('stop')}
        />
      ) : null}

      {activeTab === 'overview' ? (
      <>
      <StreamMonitoringStatusStrip
        displayStatus={displayStatus}
        backendStreamId={backendStreamId}
        hasRuntimeObsApi={hasRuntimeObsApi}
        backendStatusLabel={runtimeStats?.stream_status ?? runtimeHealth?.stream_status}
        events1h={events1h}
        eventsSparkline={eventsSparkline}
        deliveryPct={deliveryPct}
        deliveryLabel={deliveryLabel}
        routesTotal={routesTotal}
        routesOk={routesOk}
        routesErr={routesErr}
        showCheckpointObservability={showCheckpointObservability}
        runtimeMetrics={runtimeMetrics}
        failedLastHour={failedLastHour}
        errorRate={errorRate}
        lastErrorAt={lastErrorAt}
        lastEventRelative={issueCtx.lastActivityRelative}
        windowSeconds={monitoringWindowSeconds}
        onExpandObservability={() => setObservabilityOpen(true)}
      />

      <StreamFlowTimeline stages={flowTimelineStages} lastRunLabel={lastRunLabel} />

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <StreamRecentIssuesPanel
            ctx={issueCtx}
            issues={operationalIssues}
            whyChain={issueWhyChain}
            governance={governanceSnapshot}
          />
        </div>
        <div className="lg:col-span-4">
          <StreamRecentEventsPanel
            streamId={streamId}
            backendStreamId={backendStreamId}
            recentLogs={recentLogLines}
            runHistory={runHistoryRows}
            logsHref={logsExplorerDrilldown ?? logsPath(streamId)}
            variant="compact"
          />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-4">
          <StreamWhyPanel ctx={issueCtx} issues={operationalIssues} whyChain={issueWhyChain} />
          <StreamInformationPanel
            streamName={streamDisplayName}
            streamGroup={connectorProductGroup ?? connectorDisplayName}
            status={displayStatus}
            createdAt={streamEntity?.created_at ? streamEntity.created_at.slice(0, 19).replace('T', ' ') : null}
            lastRun={lastRunDisplay}
            nextRun={nextRunDisplay}
            schemaVersion={schemaVersionDisplay}
            currentCheckpoint={checkpointDisplay ? String(checkpointDisplay) : null}
          />
        </div>
      </div>
      </>
      ) : null}

      {activeTab === 'metrics' ? (
        <StreamMonitoringObservabilitySection open onOpenChange={setObservabilityOpen}>
      {routeRetryTotalLastHour != null && routeRetryTotalLastHour > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200/80 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-950 dark:border-amber-800/45 dark:bg-amber-950/25 dark:text-amber-100"
        >
          <p>
            <span className="font-semibold">Delivery retries (sum, last hour):</span>{' '}
            <span className="tabular-nums font-medium">{routeRetryTotalLastHour}</span>
          </p>
          {backendStreamId != null ? (
            <Link
              to={logsExplorerPath({ stream_id: backendStreamId, status: 'retry' })}
              className="shrink-0 font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              Open retry logs
            </Link>
          ) : null}
        </div>
      ) : null}
      <section aria-label="Stream observability" className="grid gap-3 lg:grid-cols-12">
        <RuntimeChartCard title="Events over time" subtitle={runtimeMetrics ? eventsOverTimeSemantics : 'Baseline preview'} className="lg:col-span-5">
          <div className="flex h-[200px] w-full min-w-0 items-center justify-center px-3">
            {metricsLoading && !runtimeMetrics ? (
              <div className="h-[160px] w-full animate-pulse rounded-md bg-slate-200/70 dark:bg-gdc-elevated" aria-hidden />
            ) : metricsChartsEmpty ? (
              <p className="text-center text-[12px] text-slate-600 dark:text-gdc-muted">No throughput in this window.</p>
            ) : eventsOverChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={[...eventsOverChartData]} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200/80 dark:stroke-gdc-divider" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip contentStyle={{ borderRadius: 6, border: '1px solid rgb(226 232 240)', fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                  <Bar dataKey="ingested" name="Events" stackId="s" fill="#7c3aed" maxBarSize={18} />
                  <Bar dataKey="delivered" name="Delivered" stackId="s" fill="#22c55e" maxBarSize={18} />
                  <Bar dataKey="failed" name="Failed" stackId="s" fill="#ef4444" maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-[12px] text-slate-600 dark:text-gdc-muted">No chart data.</p>
            )}
          </div>
        </RuntimeChartCard>
        <RuntimeChartCard title="Events breakdown (1h)" subtitle="Delivered / failed / other" className="lg:col-span-4">
          <div className="flex h-[200px] flex-col items-center justify-center gap-2 px-3 sm:flex-row sm:items-center">
            {donutTotal > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={[...eventsBreakdownData]} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={48} outerRadius={68} paddingAngle={1.2} stroke="none">
                    {eventsBreakdownData.map((entry) => (
                      <Cell key={entry.key} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 6, border: '1px solid rgb(226 232 240)', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-[12px] text-slate-600 dark:text-gdc-muted">No volume in the last hour.</p>
            )}
          </div>
        </RuntimeChartCard>
        <RuntimeChartCard title="Stream health" subtitle="Stats + health + 1h metrics" className="lg:col-span-3">
          <ul className="space-y-1.5">
            {streamHealthSignals.map((sig) => (
              <li key={sig.label} className="flex items-start justify-between gap-2 rounded-md border border-slate-100/90 bg-slate-50/60 px-2 py-1.5 dark:border-gdc-divider dark:bg-gdc-elevated">
                <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{sig.label}</p>
                <span className="text-[11px] font-semibold tabular-nums text-slate-800 dark:text-slate-200">{sig.value}</span>
              </li>
            ))}
          </ul>
        </RuntimeChartCard>
      </section>
      </StreamMonitoringObservabilitySection>
      ) : null}

      {activeTab === 'events' ? (
        <StreamRecentEventsPanel
          streamId={streamId}
          backendStreamId={backendStreamId}
          recentLogs={recentLogLines}
          runHistory={runHistoryRows}
          logsHref={logsExplorerDrilldown ?? logsPath(streamId)}
        />
      ) : null}

      {activeTab === 'schema' ? (
        <section className="space-y-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Stream schema</h3>
              <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
                Field mapping and enrichment define the output schema for this stream.
              </p>
            </div>
            <Link
              to={streamMappingPath(streamId)}
              className="inline-flex h-8 items-center rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
            >
              Open mapping
            </Link>
          </div>
          {backendStreamId != null ? (
            <SchemaDriftPanel
              streamId={backendStreamId}
              canOperate={canRuntimeControl}
              initialSummary={governanceSnapshot?.schemaDrift}
            />
          ) : null}
          <StreamDetailDeliveryPanel
            streamId={streamId}
            connectorName={connectorDisplayName ?? data.connectorName}
            connectorProductGroup={connectorProductGroup}
            sourceLabel={runtimeSourceUi.displayName}
          />
        </section>
      ) : null}

      {activeTab === 'audit' && backendStreamId != null && runtimeSourceUi.runtime.usesPushIngest ? (
        <WebhookReceiverRuntimePanel streamId={backendStreamId} />
      ) : null}

      {activeTab === 'audit' ? <StreamDetailSettingsPanel streamId={streamId} /> : null}

      {activeTab === 'audit' ? <StreamRuntimeHealthExtension backendStreamId={backendStreamId} /> : null}

      {activeTab === 'audit' ? (
      <>
      <StreamMonitoringObservabilitySection open={observabilityOpen || true} onOpenChange={setObservabilityOpen}>
      {routeRetryTotalLastHour != null && routeRetryTotalLastHour > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200/80 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-950 dark:border-amber-800/45 dark:bg-amber-950/25 dark:text-amber-100"
        >
          <p>
            <span className="font-semibold">Delivery retries (sum, last hour):</span>{' '}
            <span className="tabular-nums font-medium">{routeRetryTotalLastHour}</span>
            <span className="text-amber-800/90 dark:text-amber-200/85"> · from route_runtime aggregates</span>
          </p>
          {backendStreamId != null ? (
            <Link
              to={logsExplorerPath({ stream_id: backendStreamId, status: 'retry' })}
              className="shrink-0 font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              Open retry logs
            </Link>
          ) : null}
        </div>
      ) : null}

      {showCheckpointObservability ? (
      <section aria-label="Sync position trace" className="mt-1">
        <div className="rounded-xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200/30 dark:border-gdc-border dark:bg-gdc-card dark:ring-slate-800/50">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Sync position trace</h3>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                Recent committed <span className="font-mono text-[10px]">checkpoint_update</span> rows — correlate with{' '}
                <span className="font-mono text-[10px]">run_id</span> in Logs.
              </p>
              {checkpointHistory?.items?.length ? (
                <ul className="mt-2 space-y-2 text-[11px]">
                  {checkpointHistory.items.slice(0, 3).map((it) => (
                    <li
                      key={it.log_id}
                      className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border border-slate-100 bg-slate-50/50 px-2 py-1.5 dark:border-gdc-divider dark:bg-gdc-elevated/60"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-slate-500 dark:text-gdc-muted">
                        {it.created_at.slice(0, 19).replace('T', ' ')}
                      </span>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono text-[10px] dark:border-gdc-border dark:bg-gdc-elevated">
                        {it.update_reason ?? '—'}
                      </span>
                      {it.partial_success ? (
                        <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-semibold text-amber-900 dark:text-amber-200">
                          Partial success
                        </span>
                      ) : null}
                      {it.run_id ? (
                        <Link
                          to={logsExplorerPath({ stream_id: backendStreamId ?? undefined, run_id: it.run_id })}
                          className="font-mono text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                        >
                          Logs
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] text-slate-600 dark:text-gdc-muted">No checkpoint_update rows in recent history window.</p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Link
                to={logsExplorerPath({ stream_id: backendStreamId ?? undefined, stage: 'checkpoint_update' })}
                className="inline-flex items-center rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-[11px] font-semibold text-violet-900 hover:bg-violet-100/80 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-100"
              >
                Open sync position logs
              </Link>
              <Link
                to={logsExplorerPath({ stream_id: backendStreamId ?? undefined, partial_success: true })}
                className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                Partial-success runs
              </Link>
            </div>
          </div>
        </div>
      </section>
      ) : null}

      <section aria-label="Delivery path operational panel">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Delivery paths · Operational</h3>
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
              Committed delivery records · {metricsWindow} aggregates
              {refreshEvery === 'off' ? ' · metrics auto-refresh off' : ` · metrics auto-refresh ${refreshEvery}`}
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-semibold">
            {canMutateWorkspace ? (
              <Link to={streamEditPath(streamId)} className="text-violet-700 hover:underline dark:text-violet-300">
                Edit Stream Workflow
              </Link>
            ) : (
              <span className="cursor-not-allowed text-slate-400 dark:text-slate-500" title="Viewer role cannot edit stream configuration.">
                Edit Stream Workflow
              </span>
            )}
            <Link to={NAV_PATH.streams} className="text-violet-700 hover:underline dark:text-violet-300">
              Back to Streams
            </Link>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <RouteOperationalPanel
            streamSlug={streamId}
            backendStreamId={backendStreamId}
            metrics={runtimeMetrics}
            loading={metricsLoading && !runtimeMetrics}
            routeToggleBusyId={routeToggleBusyId}
            onToggleEnabled={onToggleRouteEnabled}
            routeActionsReadOnly={!canRuntimeControl}
          />
        </div>
      </section>

      <section aria-label="Recent delivery failures" className="mt-4">
        <div className="mb-2">
          <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Recent delivery failures</h3>
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
            destination timeouts, HTTP 5xx, syslog refused, retry exhausted — from committed logs
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <RecentRouteErrorsPanel errors={runtimeMetrics?.recent_route_errors ?? []} loading={metricsLoading && !runtimeMetrics} />
        </div>
      </section>

      <section aria-label="Run history">
        <div className="mb-2">
          <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Run History</h3>
          <p className="text-[11px] text-slate-600 dark:text-gdc-muted">Recent pipeline runs from runtime metrics and timeline APIs.</p>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="overflow-x-auto p-2">
            <table className={opTable}>
              <thead>
                <tr className={opThRow}>
                  <th scope="col" className={opTh}>Run ID</th>
                  <th scope="col" className={opTh}>Started At</th>
                  <th scope="col" className={opTh}>Duration</th>
                  <th scope="col" className={opTh}>Status</th>
                  <th scope="col" className={opTh}>Events</th>
                  <th scope="col" className={opTh}>Delivered</th>
                  <th scope="col" className={opTh}>Failed</th>
                  <th scope="col" className={cn(opTh, 'text-right')}>Logs</th>
                </tr>
              </thead>
              <tbody>
                {runHistoryRows.map((row) => {
                  const failed = row.failed > 0
                  const partial = row.status === 'Partial'
                  const runLogsHref =
                    backendStreamId != null ? logsExplorerPath({ stream_id: backendStreamId, run_id: row.runId }) : null
                  return (
                    <tr
                      key={row.runId}
                      className={cn(
                        opTr,
                        row.status === 'Failed' && 'bg-red-500/[0.04] dark:bg-red-500/[0.06]',
                        partial && 'bg-amber-500/[0.04] dark:bg-amber-500/[0.06]',
                      )}
                    >
                      <td className={opTd}>
                        {runLogsHref ? (
                          <Link to={runLogsHref} className="font-mono text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300">
                            {row.runId}
                          </Link>
                        ) : (
                          <span className="font-mono text-[11px] font-semibold text-slate-700 dark:text-gdc-mutedStrong">{row.runId}</span>
                        )}
                      </td>
                      <td className={cn(opTd, 'whitespace-nowrap tabular-nums text-slate-700 dark:text-gdc-mutedStrong')}>{row.startedAt}</td>
                      <td className={cn(opTd, 'tabular-nums text-slate-600 dark:text-gdc-muted')}>{row.duration}</td>
                      <td className={opTd}>
                        <span className="inline-flex items-center gap-1">
                          {row.status === 'Success' ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          ) : row.status === 'Failed' ? (
                            <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" aria-hidden />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
                          )}
                          <span className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">{row.status}</span>
                        </span>
                      </td>
                      <td className={cn(opTd, 'tabular-nums font-medium text-slate-800 dark:text-slate-100')}>{row.events.toLocaleString()}</td>
                      <td className={cn(opTd, 'tabular-nums text-slate-700 dark:text-gdc-mutedStrong')}>{row.delivered.toLocaleString()}</td>
                      <td className={cn(opTd, 'tabular-nums font-semibold', failed ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-gdc-mutedStrong')}>
                        {row.failed.toLocaleString()}
                      </td>
                      <td className={cn(opTd, 'text-right')}>
                        {runLogsHref ? (
                          <Link to={runLogsHref} className="inline-flex text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300">
                            Logs
                          </Link>
                        ) : (
                          <span className="text-[11px] text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      </StreamMonitoringObservabilitySection>

      <p className="flex items-center gap-2 border-t border-slate-200/70 pt-2 text-[10px] text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
        <Radio className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
        Charts and KPIs use committed delivery records; timeline uses delivery record samples.
      </p>
      </>
      ) : null}

      {activeTab === 'audit' && backendStreamId != null ? <PipelineDebuggerPanel streamId={backendStreamId} /> : null}
        </div>

        {isGovernance && backendStreamId != null ? (
          <div
            className={cn(activeTab !== 'audit' && 'hidden')}
            aria-hidden={activeTab !== 'audit'}
            data-testid="stream-governance-drawer-host"
          >
            <StreamGovernanceDrawer
              streamId={backendStreamId}
              canOperate={canRuntimeControl}
              schemaDriftPolicy={schemaDriftPolicyLabels}
              governanceSnapshot={governanceSnapshot}
              summaryChips={[
                { label: 'Sensitive', value: 'Drawer' },
                { label: 'Policy', value: 'Drawer' },
                { label: 'Queues', value: 'Drawer' },
              ]}
            />
          </div>
        ) : null}
      </div>

      {backfillOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="backfill-modal-title"
          data-testid="stream-backfill-modal"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-gdc-border dark:bg-gdc-card">
            <h3 id="backfill-modal-title" className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Historical replay (backfill)
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
              Replays the selected time window through this stream&apos;s mapping, enrichment, and routes. Production checkpoint is not advanced
              by this job.
            </p>
            <div
              className={cn(
                'mt-3 rounded-lg border px-3 py-2 text-[11px] font-medium',
                bfDryRun
                  ? 'border-sky-200/90 bg-sky-50 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/35 dark:text-sky-100'
                  : 'border-amber-300/90 bg-amber-500/[0.12] text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-100',
              )}
              role="status"
            >
              {bfDryRun ? (
                <>
                  <span className="font-semibold">Dry-run mode</span> — simulates the replay pipeline; destinations are not sent production
                  traffic from this action.
                </>
              ) : (
                <>
                  <span className="font-semibold">Live replay mode</span> — may deliver to configured destinations for historical rows. Confirm
                  the window and downstream impact before running.
                </>
              )}
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-200" htmlFor="bf-start">
                Start (local)
              </label>
              <input
                id="bf-start"
                type="datetime-local"
                value={bfStart}
                onChange={(e) => setBfStart(e.target.value)}
                className="h-9 w-full rounded-md border border-slate-200 px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100 dark:[color-scheme:dark]"
              />
              <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-200" htmlFor="bf-end">
                End (local)
              </label>
              <input
                id="bf-end"
                type="datetime-local"
                value={bfEnd}
                onChange={(e) => setBfEnd(e.target.value)}
                className="h-9 w-full rounded-md border border-slate-200 px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100 dark:[color-scheme:dark]"
              />
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200/90 bg-slate-50/80 px-2.5 py-2 text-[12px] text-slate-800 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={bfDryRun}
                  onChange={(e) => setBfDryRun(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span>
                  <span className="font-semibold">Dry run</span>
                  <span className="mt-0.5 block text-[11px] font-normal text-slate-600 dark:text-gdc-muted">
                    Dry run only — no events are delivered to destinations during replay.
                  </span>
                </span>
              </label>
            </div>
            {bfError ? (
              <p className="mt-3 text-[12px] font-medium text-red-700 dark:text-red-300" role="alert">
                {bfError}
              </p>
            ) : null}
            {bfResult?.delivery_summary_json ? (
              <div
                className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50 p-3 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
                data-testid="stream-backfill-result"
              >
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Replay summary</p>
                <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
                  Mode:{' '}
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {bfLastWasDryRun === true ? 'Dry-run' : bfLastWasDryRun === false ? 'Live' : '—'}
                  </span>
                  {bfResult.status ? (
                    <>
                      {' '}
                      · Job status: <span className="font-mono font-semibold">{bfResult.status}</span>
                    </>
                  ) : null}
                </p>
                <ul className="mt-2 space-y-1 border-t border-slate-200/80 pt-2 text-slate-800 dark:text-slate-100 dark:border-gdc-divider">
                  <li className="flex justify-between gap-2">
                    <span className="text-slate-600 dark:text-gdc-muted">Delivery outcome</span>
                    <span className="font-mono font-semibold">{String((bfResult.delivery_summary_json as Record<string, unknown>).status ?? '—')}</span>
                  </li>
                  <li className="flex justify-between gap-2 tabular-nums">
                    <span className="text-slate-600 dark:text-gdc-muted">Sent</span>
                    <span>{String((bfResult.delivery_summary_json as Record<string, unknown>).sent ?? '—')}</span>
                  </li>
                  <li className="flex justify-between gap-2 tabular-nums">
                    <span className="text-slate-600 dark:text-gdc-muted">Failed</span>
                    <span className="text-red-700 dark:text-red-300">
                      {String((bfResult.delivery_summary_json as Record<string, unknown>).failed ?? '—')}
                    </span>
                  </li>
                  <li className="flex justify-between gap-2 tabular-nums">
                    <span className="text-slate-600 dark:text-gdc-muted">Skipped</span>
                    <span>{String((bfResult.delivery_summary_json as Record<string, unknown>).skipped ?? '—')}</span>
                  </li>
                </ul>
                {bfResult.error_summary ? (
                  <p className="mt-2 text-[11px] text-red-700 dark:text-red-300">Error: {bfResult.error_summary}</p>
                ) : null}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setBackfillOpen(false)
                  setBfResult(null)
                  setBfError(null)
                  setBfLastWasDryRun(null)
                }}
                className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200"
              >
                Close
              </button>
              <button
                type="button"
                data-testid="stream-backfill-submit"
                disabled={bfBusy || !bfStart || !bfEnd}
                onClick={() => void executeBackfill()}
                className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              >
                {bfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {bfBusy ? 'Running…' : bfDryRun ? 'Run dry-run' : 'Run live replay'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
