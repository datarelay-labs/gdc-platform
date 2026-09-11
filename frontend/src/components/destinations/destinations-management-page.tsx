import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  createDestination,
  deleteDestination,
  previewTestDestination,
  testDestination,
  updateDestination,
  type DestinationListItem,
  type DestinationWritePayload,
  type DestinationTestResult,
} from '../../api/gdcDestinations'
import { useDestinationsOverviewData, type DestinationOverviewRow } from './use-destinations-overview-data'
import type { DestinationUiHealth } from './destination-runtime-metrics'
import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { parseDestinationsHealthFilterFromSearch, streamsTimeRangeLabel } from '../../constants/streamConsoleFilters'
import {
  loadStreamsAutoRefresh,
  loadStreamsTimeRange,
  persistStreamsAutoRefresh,
  persistStreamsTimeRange,
  type StreamsAutoRefreshOption,
} from '../../localPreferences'
import { destinationDetailPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { HelpTooltip } from '../ui/help-tooltip'
import { HELP_COPY } from '../ui/help-tooltip-copy'
import { DestinationsKpiStrip, computeDestinationsKpi } from './destination-kpi-strip'
import { DestinationDetailDrawer, type LastTestResult } from './destination-detail-drawer'
import { DestinationCardView } from './destination-card-view'
import {
  CapacityCell,
  CapacityGaugePreviewCard,
  DonutChart,
  HealthBadge,
  QueueDepthCell,
  extractCapacityConfig,
} from './destination-mini-charts'

// ─── Form state ───────────────────────────────────────────────────────────────

type WebhookPayloadMode = 'SINGLE_EVENT_OBJECT' | 'BATCH_JSON_ARRAY'
type TlsVerifyMode = 'strict' | 'insecure_skip_verify'

function normalizeWebhookPayloadMode(raw: unknown): WebhookPayloadMode {
  if (raw === 'BATCH_JSON_ARRAY') return 'BATCH_JSON_ARRAY'
  return 'SINGLE_EVENT_OBJECT'
}

function normalizeTlsVerifyMode(raw: unknown): TlsVerifyMode {
  if (raw === 'insecure_skip_verify') return 'insecure_skip_verify'
  return 'strict'
}

type FormState = {
  name: string
  destination_type: DestinationListItem['destination_type']
  host: string
  port: string
  url: string
  webhookPayloadMode: WebhookPayloadMode
  enabled: boolean
  tlsVerifyMode: TlsVerifyMode
  tlsCaCertPath: string
  tlsClientCertPath: string
  tlsClientKeyPath: string
  tlsServerName: string
  tlsConnectTimeout: string
  tlsWriteTimeout: string
  // Capacity & Monitoring
  capacityLimitEps: string    // '' = no value set; ignored when capacityUnlimited
  capacityUnlimited: boolean  // true → no capacity limit (capacity_limit_eps = null)
  capacityWarningPct: string  // 1–99, default '70'
  capacityCriticalPct: string // 1–100, default '85'
}

type SheetMode = 'closed' | 'create' | 'edit'

const INITIAL_FORM: FormState = {
  name: '',
  destination_type: 'SYSLOG_UDP',
  host: '',
  port: '514',
  url: '',
  webhookPayloadMode: 'SINGLE_EVENT_OBJECT',
  enabled: true,
  tlsVerifyMode: 'strict',
  tlsCaCertPath: '',
  tlsClientCertPath: '',
  tlsClientKeyPath: '',
  tlsServerName: '',
  tlsConnectTimeout: '5',
  tlsWriteTimeout: '5',
  capacityLimitEps: '',
  capacityUnlimited: false,
  capacityWarningPct: '70',
  capacityCriticalPct: '85',
}

function defaultPortFor(type: DestinationListItem['destination_type']): string {
  if (type === 'SYSLOG_TLS') return '6514'
  return '514'
}

function buildTargetSummary(row: DestinationListItem): string {
  if (row.destination_type === 'WEBHOOK_POST') {
    return String(row.config_json.url ?? '-')
  }
  const host = String(row.config_json.host ?? '-')
  const port = String(row.config_json.port ?? '-')
  const proto =
    row.destination_type === 'SYSLOG_TLS' ? 'tls' : row.destination_type === 'SYSLOG_TCP' ? 'tcp' : 'udp'
  return `${host}:${port} / ${proto}`
}

function buildCapacityRateLimitJson(form: FormState): Record<string, unknown> {
  const warningPct = Math.max(1, Math.min(99, parseInt(form.capacityWarningPct) || 70))
  const criticalPct = Math.max(1, Math.min(100, parseInt(form.capacityCriticalPct) || 85))
  const rl: Record<string, unknown> = {
    capacity_unit: 'EPS',
    capacity_warning_threshold_pct: warningPct,
    capacity_critical_threshold_pct: criticalPct,
  }
  if (!form.capacityUnlimited && form.capacityLimitEps.trim() !== '') {
    const eps = parseFloat(form.capacityLimitEps)
    if (Number.isFinite(eps) && eps >= 1) rl.capacity_limit_eps = eps
  }
  return rl
}

function payloadFromForm(form: FormState): DestinationWritePayload {
  const rate_limit_json = buildCapacityRateLimitJson(form)

  if (form.destination_type === 'WEBHOOK_POST') {
    return {
      name: form.name.trim(),
      destination_type: 'WEBHOOK_POST',
      enabled: form.enabled,
      config_json: { url: form.url.trim(), payload_mode: form.webhookPayloadMode },
      rate_limit_json,
    }
  }
  if (form.destination_type === 'SYSLOG_TLS') {
    const cfg: Record<string, unknown> = {
      host: form.host.trim(),
      port: Number(form.port),
      tls_enabled: true,
      tls_verify_mode: form.tlsVerifyMode,
    }
    if (form.tlsCaCertPath.trim()) cfg.tls_ca_cert_path = form.tlsCaCertPath.trim()
    if (form.tlsClientCertPath.trim()) cfg.tls_client_cert_path = form.tlsClientCertPath.trim()
    if (form.tlsClientKeyPath.trim()) cfg.tls_client_key_path = form.tlsClientKeyPath.trim()
    if (form.tlsServerName.trim()) cfg.tls_server_name = form.tlsServerName.trim()
    if (form.tlsConnectTimeout.trim()) cfg.connect_timeout = Number(form.tlsConnectTimeout)
    if (form.tlsWriteTimeout.trim()) cfg.write_timeout = Number(form.tlsWriteTimeout)
    return {
      name: form.name.trim(),
      destination_type: 'SYSLOG_TLS',
      enabled: form.enabled,
      config_json: cfg,
      rate_limit_json,
    }
  }
  return {
    name: form.name.trim(),
    destination_type: form.destination_type,
    enabled: form.enabled,
    config_json: {
      host: form.host.trim(),
      port: Number(form.port),
      protocol: form.destination_type === 'SYSLOG_TCP' ? 'tcp' : 'udp',
    },
    rate_limit_json,
  }
}

function formFromRow(row: DestinationListItem): FormState {
  const cfg = row.config_json || {}
  const { limitEps, thresholds } = extractCapacityConfig(row)
  return {
    name: row.name,
    destination_type: row.destination_type,
    host: String(cfg.host ?? ''),
    port: String(cfg.port ?? defaultPortFor(row.destination_type)),
    url: String(cfg.url ?? ''),
    webhookPayloadMode: normalizeWebhookPayloadMode(cfg.payload_mode),
    enabled: row.enabled,
    tlsVerifyMode: normalizeTlsVerifyMode(cfg.tls_verify_mode),
    tlsCaCertPath: String(cfg.tls_ca_cert_path ?? ''),
    tlsClientCertPath: String(cfg.tls_client_cert_path ?? ''),
    tlsClientKeyPath: String(cfg.tls_client_key_path ?? ''),
    tlsServerName: String(cfg.tls_server_name ?? ''),
    tlsConnectTimeout: cfg.connect_timeout != null ? String(cfg.connect_timeout) : '5',
    tlsWriteTimeout: cfg.write_timeout != null ? String(cfg.write_timeout) : '5',
    capacityLimitEps: limitEps != null ? String(limitEps) : '',
    capacityUnlimited: limitEps == null,
    capacityWarningPct: String(thresholds.warningPct),
    capacityCriticalPct: String(thresholds.criticalPct),
  }
}


function formatEps(eps: number | null): string {
  if (eps == null || !Number.isFinite(eps)) return '—'
  if (eps === 0) return '0'
  if (eps < 0.01) return '<0.01'
  return eps < 10 ? eps.toFixed(2) : eps.toFixed(1)
}


function protocolLabel(form: FormState): string {
  if (form.destination_type === 'WEBHOOK_POST') return 'HTTPS POST'
  if (form.destination_type === 'SYSLOG_TLS') return 'TCP + TLS'
  if (form.destination_type === 'SYSLOG_TCP') return 'TCP'
  return 'UDP'
}

function validateCapacityForm(form: FormState): string | null {
  if (!form.capacityUnlimited && form.capacityLimitEps.trim() !== '') {
    const eps = parseFloat(form.capacityLimitEps)
    if (!Number.isFinite(eps) || eps < 1 || eps > 1_000_000) {
      return 'Maximum Throughput must be between 1 and 1,000,000 EPS.'
    }
  }
  const warning = parseInt(form.capacityWarningPct)
  const critical = parseInt(form.capacityCriticalPct)
  if (isNaN(warning) || warning < 1 || warning > 99) {
    return 'Warning Threshold must be between 1 and 99.'
  }
  if (isNaN(critical) || critical < 1 || critical > 100) {
    return 'Critical Threshold must be between 1 and 100.'
  }
  if (warning >= critical) {
    return 'Warning Threshold must be less than Critical Threshold.'
  }
  return null
}

type TestBottomToast = {
  destinationName: string
  success: boolean
  message: string
  latencyMs: number
  tlsDetail?: {
    verifyMode?: string
    negotiatedVersion?: string | null
    cipher?: string | null
    serverName?: string
  } | null
}

function extractTlsDetail(detail: Record<string, unknown> | null | undefined): TestBottomToast['tlsDetail'] {
  if (!detail || typeof detail !== 'object') return null
  if (detail.protocol !== 'tls') return null
  return {
    verifyMode: typeof detail.verify_mode === 'string' ? detail.verify_mode : undefined,
    negotiatedVersion:
      typeof detail.negotiated_tls_version === 'string'
        ? detail.negotiated_tls_version
        : detail.negotiated_tls_version == null
          ? null
          : String(detail.negotiated_tls_version),
    cipher:
      typeof detail.cipher === 'string'
        ? detail.cipher
        : detail.cipher == null
          ? null
          : String(detail.cipher),
    serverName: typeof detail.server_name === 'string' ? detail.server_name : undefined,
  }
}

// ─── Type badge ───────────────────────────────────────────────────────────────

const TYPE_BADGE: Record<string, string> = {
  SYSLOG_UDP: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  SYSLOG_TCP: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  SYSLOG_TLS: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  WEBHOOK_POST: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', TYPE_BADGE[type] ?? 'border-slate-600 bg-slate-700/30 text-slate-400')}>
      {type.replace('_', ' ')}
    </span>
  )
}

// ─── Row kebab menu ───────────────────────────────────────────────────────────

function RowKebabMenu({
  row,
  onOpenDetail,
  onEdit,
  onTest,
  onToggleEnabled,
  onDelete,
  testBusy,
  actionBusy,
}: {
  row: DestinationOverviewRow
  onOpenDetail: () => void
  onEdit: () => void
  onTest: () => void
  onToggleEnabled: (next: boolean) => void
  onDelete: () => void
  testBusy: boolean
  actionBusy: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const items = [
    { label: 'Open detail', action: onOpenDetail },
    { label: 'Edit', action: onEdit, disabled: !row.enabled },
    { label: testBusy ? 'Testing…' : 'Test delivery', action: onTest, disabled: testBusy },
    { label: row.enabled ? 'Disable' : 'Enable', action: () => onToggleEnabled(!row.enabled), disabled: actionBusy },
    { label: 'Delete', action: onDelete, danger: true },
  ]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-[#1e2a3b] text-slate-400 hover:border-slate-500 hover:text-slate-200"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 min-w-[150px] rounded-lg border border-[#1e2a3b] bg-[#0a1628] py-1 shadow-xl">
          {items.map(({ label, action, danger, disabled }) => (
            <button
              key={label}
              type="button"
              disabled={disabled}
              onClick={() => { setOpen(false); action() }}
              className={cn(
                'block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[#1e2a3b] disabled:opacity-50 disabled:cursor-not-allowed',
                danger ? 'text-red-400 hover:text-red-300' : 'text-slate-300 hover:text-slate-100'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Pagination ───────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]

function Pagination({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number
  page: number
  pageSize: PageSize
  onPage: (p: number) => void
  onPageSize: (s: PageSize) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex items-center justify-between px-3 py-2 text-[11px] text-slate-400">
      <div className="flex items-center gap-2">
        <span>Rows per page</span>
        <select
          value={pageSize}
          onChange={(e) => { onPageSize(Number(e.target.value) as PageSize); onPage(1) }}
          className="rounded border border-[#1e2a3b] bg-[#0a1628] px-1.5 py-0.5 text-[11px] text-slate-300"
        >
          {PAGE_SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <span className="mr-2">{from}–{to} of {total}</span>
        <button type="button" disabled={page <= 1} onClick={() => onPage(1)} className="rounded p-1 hover:bg-[#1e2a3b] disabled:opacity-30">
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded p-1 hover:bg-[#1e2a3b] disabled:opacity-30">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="px-1 tabular-nums">{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="rounded p-1 hover:bg-[#1e2a3b] disabled:opacity-30">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(totalPages)} className="rounded p-1 hover:bg-[#1e2a3b] disabled:opacity-30">
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ─── Form-level probe result (persisted until save/close) ─────────────────────

type FormProbeResult = {
  success: boolean
  latencyMs: number
  message: string
  testedAt: string
}

// ─── Capacity Recommendation Card ─────────────────────────────────────────────

function CapacityRecommendationCard({
  currentEps,
  peakEps,
  configuredLimitEps,
  unlimited,
  warningPct,
  criticalPct,
  onApply,
}: {
  currentEps: number | null
  peakEps: number | null
  configuredLimitEps: number | null
  unlimited: boolean
  warningPct: number
  criticalPct: number
  onApply: (eps: number) => void
}) {
  const recommendedEps =
    peakEps != null && peakEps > 0
      ? Math.round(peakEps * 1.2)
      : currentEps != null && currentEps > 0
      ? Math.round(currentEps * 1.3)
      : null

  const currentUsagePct =
    !unlimited && configuredLimitEps != null && configuredLimitEps > 0 && currentEps != null
      ? Math.round((currentEps / configuredLimitEps) * 100)
      : null

  const peakUsagePct =
    !unlimited && configuredLimitEps != null && configuredLimitEps > 0 && peakEps != null
      ? Math.round((peakEps / configuredLimitEps) * 100)
      : null

  const remainingEps =
    !unlimited && configuredLimitEps != null && currentEps != null
      ? Math.max(0, configuredLimitEps - currentEps)
      : null

  const headroomEps =
    !unlimited && configuredLimitEps != null && peakEps != null
      ? configuredLimitEps - peakEps
      : null

  const isPeakCritical = peakUsagePct != null && peakUsagePct >= criticalPct
  const usageColor =
    currentUsagePct == null ? 'text-slate-500'
    : currentUsagePct >= criticalPct ? 'text-red-400'
    : currentUsagePct >= warningPct ? 'text-amber-400'
    : 'text-emerald-400'

  function fmtEps(v: number | null): string {
    if (v == null) return '—'
    if (v === 0) return '0'
    return v < 10 ? v.toFixed(2) : v.toFixed(1)
  }

  return (
    <div className="rounded-xl border border-[#1e2a3b] bg-[#0a1628] p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Capacity Recommendation</p>

      <div className="space-y-2 text-[12px]">
        {/* Traffic metrics */}
        {([
          { label: 'Current Traffic', value: currentEps != null ? `${fmtEps(currentEps)} EPS` : '—' },
          { label: '5 Min Avg', value: currentEps != null ? `${fmtEps(currentEps)} EPS` : '—' },
          { label: 'Peak (24h)', value: peakEps != null ? `${fmtEps(peakEps)} EPS` : '—' },
        ] as const).map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-slate-500">{label}</span>
            <span className="tabular-nums font-semibold text-slate-300">{value}</span>
          </div>
        ))}

        <div className="border-t border-[#1e2a3b] pt-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">Configured</span>
            <span className="tabular-nums font-semibold text-slate-300">
              {unlimited ? 'No limit' : configuredLimitEps != null ? `${configuredLimitEps.toLocaleString()} EPS` : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">Recommended</span>
            <span className={cn('tabular-nums font-semibold', recommendedEps != null ? 'text-violet-300' : 'text-slate-500 italic')}>
              {recommendedEps != null ? `${recommendedEps.toLocaleString()} EPS` : 'Unavailable'}
            </span>
          </div>
        </div>

        {/* Expected Usage + Remaining (only when a limit is set) */}
        {!unlimited && configuredLimitEps != null && (
          <div className="border-t border-[#1e2a3b] pt-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Expected Usage</span>
              <span className={cn('tabular-nums font-semibold', usageColor)}>
                {currentUsagePct != null ? `${currentUsagePct}%` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Remaining</span>
              <span className="tabular-nums font-semibold text-slate-300">
                {remainingEps != null ? `${fmtEps(remainingEps)} EPS` : '—'}
              </span>
            </div>
            {headroomEps != null && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Headroom</span>
                <span className={cn('tabular-nums font-semibold', headroomEps < 0 ? 'text-red-400' : 'text-slate-300')}>
                  {fmtEps(headroomEps)} EPS
                </span>
              </div>
            )}
          </div>
        )}

        {/* Peak Warning badge */}
        {isPeakCritical && (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5">
            <span className="text-[9px] font-bold uppercase text-red-400">Peak Warning</span>
            <span className="text-[11px] text-red-300">Peak reached {peakUsagePct}% of capacity</span>
          </div>
        )}
      </div>

      {/* Apply / Unavailable */}
      {recommendedEps != null ? (
        <button
          type="button"
          onClick={() => onApply(recommendedEps)}
          className="mt-4 w-full rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-[12px] font-semibold text-violet-300 transition-colors hover:bg-violet-500/20"
        >
          Apply Recommendation ({recommendedEps.toLocaleString()} EPS)
        </button>
      ) : (
        <p className="mt-3 text-[11px] italic text-slate-600">
          Recommendation unavailable — no traffic data yet.
        </p>
      )}
    </div>
  )
}

// ─── Test Connection Result Card ───────────────────────────────────────────────

function TestConnectionResultCard({ result }: { result: FormProbeResult }) {
  return (
    <div className={cn(
      'rounded-xl border p-4',
      result.success
        ? 'border-emerald-500/30 bg-emerald-950/20'
        : 'border-red-500/30 bg-red-950/20',
    )}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Test Connection</p>
      <div className="space-y-2 text-[12px]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Connection</span>
          <span className={cn('font-bold', result.success ? 'text-emerald-400' : 'text-red-400')}>
            {result.success ? '✓ Success' : '✗ Failed'}
          </span>
        </div>
        {result.success && result.latencyMs > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">Latency</span>
            <span className="tabular-nums font-semibold text-slate-200">{result.latencyMs.toFixed(1)} ms</span>
          </div>
        )}
        {!result.success && result.message && (
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 text-slate-500">Error</span>
            <span className="text-right text-[11px] text-red-300 line-clamp-2">{result.message}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Last Tested</span>
          <span className="text-slate-400">{result.testedAt}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Column header ────────────────────────────────────────────────────────────

const TH = 'px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap'
const TD = 'px-3 py-2.5'

// ─── Main Component ───────────────────────────────────────────────────────────

export function DestinationsManagementPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [autoRefresh, setAutoRefresh] = useState<StreamsAutoRefreshOption>('Off')
  const [timeRange, setTimeRange] = useState<StreamsMetricsWindow>('1h')
  const [refreshVersion, setRefreshVersion] = useState(0)

  useLayoutEffect(() => {
    setAutoRefresh(loadStreamsAutoRefresh())
    setTimeRange(loadStreamsTimeRange())
  }, [])

  const { rows, loading, runtimeLoading, error, runtimeError, refresh } = useDestinationsOverviewData({
    timeRange,
    refreshVersion,
  })

  // ─── Auto-refresh ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoRefresh === 'Off') return
    const ms =
      autoRefresh === '15s' ? 15_000
      : autoRefresh === '30s' ? 30_000
      : autoRefresh === '1m' ? 60_000
      : autoRefresh === '5m' ? 300_000
      : 0
    if (!ms) return
    const id = window.setInterval(() => setRefreshVersion((v) => v + 1), ms)
    return () => window.clearInterval(id)
  }, [autoRefresh])

  const handleAutoRefreshChange = useCallback((value: StreamsAutoRefreshOption) => {
    setAutoRefresh(value)
    persistStreamsAutoRefresh(value)
  }, [])

  const handleTimeRangeChange = useCallback((value: StreamsMetricsWindow) => {
    setTimeRange(value)
    persistStreamsTimeRange(value)
    setRefreshVersion((v) => v + 1)
  }, [])


  // ─── CRUD state ────────────────────────────────────────────────────────────

  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [sheetMode, setSheetMode] = useState<SheetMode>('closed')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingRow, setEditingRow] = useState<DestinationOverviewRow | null>(null)
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [probeOk, setProbeOk] = useState<boolean | null>(null)
  const [probeBusy, setProbeBusy] = useState(false)
  const [probeBanner, setProbeBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [probeResult, setProbeResult] = useState<FormProbeResult | null>(null)
  const [testBusyId, setTestBusyId] = useState<number | null>(null)
  const [actionBusyId, setActionBusyId] = useState<number | null>(null)
  const [deleteBlocked, setDeleteBlocked] = useState<{ title: string; message: string; destinationId?: number } | null>(null)
  const [deleteModal, setDeleteModal] = useState<{ row: DestinationListItem; confirm: string } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [testBottomToast, setTestBottomToast] = useState<TestBottomToast | null>(null)
  const testToastClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─── Drawer & view ────────────────────────────────────────────────────────

  const [drawerRow, setDrawerRow] = useState<DestinationOverviewRow | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table')
  /** Last test result keyed by destination id */
  const [testResultById, setTestResultById] = useState<Map<number, LastTestResult>>(new Map())

  // ─── Filters & pagination ─────────────────────────────────────────────────

  const [searchQ, setSearchQ] = useState('')
  const [healthFilterLocal, setHealthFilterLocal] = useState<'ALL' | DestinationUiHealth>('ALL')
  const healthFilterFromUrl = useMemo(
    () => parseDestinationsHealthFilterFromSearch(location.search),
    [location.search],
  )
  /** URL `?filter=warning` owns Warning selection; other values use local state. */
  const healthFilter: 'ALL' | DestinationUiHealth = healthFilterFromUrl ?? healthFilterLocal

  const setHealthFilter = useCallback(
    (next: 'ALL' | DestinationUiHealth) => {
      const params = new URLSearchParams(location.search)
      if (next === 'Warning') params.set('filter', 'warning')
      else params.delete('filter')
      const qs = params.toString()
      navigate(qs ? `/destinations?${qs}` : '/destinations')
      setHealthFilterLocal(next)
    },
    [location.search, navigate],
  )

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(10)

  // KPI
  const kpi = useMemo(() => computeDestinationsKpi(rows), [rows])

  const filteredRows = useMemo(() => {
    let list = [...rows]
    const q = searchQ.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          String(r.id).includes(q) ||
          buildTargetSummary(r).toLowerCase().includes(q) ||
          r.routes.some((rt) => rt.stream_name.toLowerCase().includes(q)),
      )
    }
    if (healthFilter !== 'ALL') {
      list = list.filter((r) => r.runtime.health === healthFilter)
    }
    return list.sort((a, b) => a.id - b.id)
  }, [rows, searchQ, healthFilter])

  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredRows.slice(start, start + pageSize)
  }, [filteredRows, page, pageSize])

  // Reset to page 1 on filter change
  useEffect(() => { setPage(1) }, [searchQ, healthFilter])

  // ─── Toast helpers ─────────────────────────────────────────────────────────

  function dismissTestToast() {
    if (testToastClearTimerRef.current) {
      clearTimeout(testToastClearTimerRef.current)
      testToastClearTimerRef.current = null
    }
    setTestBottomToast(null)
  }

  function showTestToast(payload: TestBottomToast) {
    if (testToastClearTimerRef.current) clearTimeout(testToastClearTimerRef.current)
    setTestBottomToast(payload)
    testToastClearTimerRef.current = setTimeout(() => {
      setTestBottomToast(null)
      testToastClearTimerRef.current = null
    }, 10000)
  }

  useEffect(() => {
    return () => {
      if (testToastClearTimerRef.current) clearTimeout(testToastClearTimerRef.current)
    }
  }, [])

  // ─── Sheet helpers ─────────────────────────────────────────────────────────

  function openCreateSheet() {
    setEditingId(null)
    setEditingRow(null)
    setSheetMode('create')
    setForm(INITIAL_FORM)
    setProbeOk(null)
    setProbeBanner(null)
    setProbeResult(null)
    setLocalError(null)
  }

  function openEditSheet(row: DestinationOverviewRow) {
    setEditingId(row.id)
    setEditingRow(row)
    setSheetMode('edit')
    setForm(formFromRow(row))
    setProbeOk(null)
    setProbeBanner(null)
    setProbeResult(null)
    setLocalError(null)
  }

  function closeSheet() {
    setSheetMode('closed')
    setEditingId(null)
    setEditingRow(null)
    setForm(INITIAL_FORM)
    setProbeOk(null)
    setProbeBanner(null)
    setProbeResult(null)
  }

  async function onProbeForm() {
    if (!form.name.trim()) {
      setProbeBanner({ tone: 'error', text: 'Enter a name before running the connection test.' })
      return
    }
    if (form.destination_type === 'WEBHOOK_POST' && !form.url.trim()) {
      setProbeBanner({ tone: 'error', text: 'Enter a URL for the webhook destination.' })
      return
    }
    if (form.destination_type !== 'WEBHOOK_POST' && (!form.host.trim() || !form.port.trim())) {
      setProbeBanner({ tone: 'error', text: 'Enter both host and port before testing.' })
      return
    }
    setProbeBusy(true)
    setProbeBanner(null)
    setLocalError(null)
    try {
      const payload = payloadFromForm(form)
      const result = await previewTestDestination(payload)
      const testedAt = new Date().toLocaleTimeString()
      setProbeOk(result.success)
      setProbeResult({
        success: result.success,
        latencyMs: Number(result.latency_ms),
        message: result.message,
        testedAt,
      })
      setProbeBanner({
        tone: result.success ? 'success' : 'error',
        text: `${result.success ? 'Test finished (ok)' : 'Test finished (failed)'} · ${result.message} · ${Number(result.latency_ms).toFixed(1)} ms`,
      })
    } catch (err) {
      const testedAt = new Date().toLocaleTimeString()
      const message = err instanceof Error ? err.message : 'Connection test request failed.'
      setProbeOk(false)
      setProbeResult({ success: false, latencyMs: 0, message, testedAt })
      setProbeBanner({ tone: 'error', text: message })
    } finally {
      setProbeBusy(false)
    }
  }

  async function onSubmitSheet(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    if (form.destination_type === 'WEBHOOK_POST' && !form.url.trim()) return
    if (form.destination_type !== 'WEBHOOK_POST' && (!form.host.trim() || !form.port.trim())) return

    setSaving(true)
    setLocalError(null)
    try {
      const payload = payloadFromForm(form)
      if (sheetMode === 'create') {
        await createDestination(payload)
      } else if (sheetMode === 'edit' && editingId != null) {
        await updateDestination(editingId, payload)
      }
      closeSheet()
      await refresh()
      if (probeOk === false) {
        setLocalError('Saved. Last connection test had not succeeded — verify connectivity when possible.')
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  function openDeleteFlow(row: DestinationListItem) {
    setDeleteBlocked(null)
    if (row.enabled) {
      setDeleteBlocked({
        title: 'Cannot delete destination',
        message: `'${row.name}' is still enabled. Disable it before deleting.`,
        destinationId: row.id,
      })
      return
    }
    if (row.routes.length > 0) {
      setDeleteBlocked({
        title: 'Cannot delete destination',
        message: `'${row.name}' is used by ${row.streams_using_count} stream(s). Disable or remove all stream routes using this destination before deleting.`,
        destinationId: row.id,
      })
      return
    }
    setDeleteModal({ row, confirm: '' })
  }

  async function executeDelete() {
    if (!deleteModal) return
    if (deleteModal.confirm.trim() !== deleteModal.row.name.trim()) return
    setDeleteBusy(true)
    setLocalError(null)
    try {
      await deleteDestination(deleteModal.row.id)
      setDeleteModal(null)
      await refresh()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Delete failed.')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function onTestRow(row: DestinationListItem) {
    setTestBusyId(row.id)
    setLocalError(null)
    const testTime = new Date().toISOString().slice(0, 19).replace('T', ' ')
    try {
      const result: DestinationTestResult = await testDestination(row.id)
      await refresh()
      // Persist result for Detail Drawer
      setTestResultById((prev) => {
        const next = new Map(prev)
        next.set(row.id, {
          time: testTime,
          success: result.success,
          latencyMs: Number(result.latency_ms),
          message: result.message,
          responseCode: null,
        })
        return next
      })
      showTestToast({
        destinationName: row.name,
        success: result.success,
        message: result.message,
        latencyMs: Number(result.latency_ms),
        tlsDetail: extractTlsDetail(result.detail ?? null),
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Test request failed.'
      setTestResultById((prev) => {
        const next = new Map(prev)
        next.set(row.id, { time: testTime, success: false, latencyMs: 0, message: errMsg })
        return next
      })
      showTestToast({
        destinationName: row.name,
        success: false,
        message: errMsg,
        latencyMs: 0,
        tlsDetail: null,
      })
    } finally {
      setTestBusyId(null)
    }
  }

  async function onToggleEnabled(row: DestinationListItem, nextEnabled: boolean) {
    setActionBusyId(row.id)
    setLocalError(null)
    try {
      await updateDestination(row.id, { enabled: nextEnabled })
      await refresh()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Update failed.')
    } finally {
      setActionBusyId(null)
    }
  }

  const sheetOpen = sheetMode !== 'closed'
  const isRefreshing = loading || runtimeLoading

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 bg-[#070f1c] min-h-screen p-5">

      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Destinations</h1>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Monitor delivery capacity and health of all destinations
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            For cross-stream route delivery diagnostics, open the{' '}
            <Link to="/routes" className="font-semibold text-violet-400 hover:underline" data-testid="destinations-routes-console-link">
              Routes console
            </Link>
            .
          </p>
        </div>

        {/* Right-side controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* New Destination button */}
          <button
            type="button"
            onClick={openCreateSheet}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-500 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New Destination
          </button>

          {/* Time Range */}
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <span className="shrink-0">Time range</span>
            <select
              value={timeRange}
              onChange={(e) => handleTimeRangeChange(e.target.value as StreamsMetricsWindow)}
              className="rounded-lg border border-[#1e2a3b] bg-[#0a1628] px-2 py-1.5 text-[12px] font-semibold text-slate-200"
              aria-label="Metrics time range"
            >
              {(['15m', '1h', '24h', '7d', '30d'] as const).map((w) => (
                <option key={w} value={w}>{streamsTimeRangeLabel(w)}</option>
              ))}
            </select>
          </label>

          {/* Manual Refresh */}
          <button
            type="button"
            onClick={() => { void refresh() }}
            disabled={isRefreshing}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#1e2a3b] bg-[#0a1628] text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-50 transition-colors"
            aria-label="Refresh now"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </button>

          {/* Auto Refresh */}
          <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <span className="shrink-0">Auto refresh</span>
            <select
              value={autoRefresh}
              onChange={(e) => handleAutoRefreshChange(e.target.value as StreamsAutoRefreshOption)}
              className="rounded-lg border border-[#1e2a3b] bg-[#0a1628] px-2 py-1.5 text-[12px] font-semibold text-slate-200"
              aria-label="Auto refresh interval"
            >
              {(['Off', '15s', '30s', '1m', '5m'] as const).map((opt) => (
                <option key={opt} value={opt}>{opt === 'Off' ? 'Off' : `${opt}`}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Error banners */}
      {(error || localError) && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
          {error ?? localError}
        </div>
      )}
      {runtimeError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-300">
          Runtime metrics unavailable: {runtimeError}
        </div>
      )}

      {/* KPI Strip */}
      <DestinationsKpiStrip kpi={kpi} loading={isRefreshing && rows.length === 0} />

      {/* Table / Card toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold text-slate-300">
          Destinations
          <span className="ml-1.5 tabular-nums text-slate-500">({filteredRows.length})</span>
        </h2>

        <div className="flex flex-1 items-center gap-2 sm:max-w-xs ml-auto lg:ml-4">
          <label className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" aria-hidden />
            <input
              placeholder="Search destinations…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              className="h-9 w-full rounded-lg border border-[#1e2a3b] bg-[#0a1628] py-1 pl-8 pr-2 text-[12px] text-slate-200 placeholder:text-slate-600 focus:border-violet-500/60 focus:outline-none"
            />
          </label>
        </div>

        {/* Status filter */}
        <select
          value={healthFilter}
          onChange={(e) => setHealthFilter(e.target.value as typeof healthFilter)}
          className="h-9 rounded-lg border border-[#1e2a3b] bg-[#0a1628] px-2 text-[12px] text-slate-200"
          aria-label="Filter destinations by health status"
          data-testid="destinations-health-filter"
        >
          <option value="ALL">All Status</option>
          <option value="Healthy">Healthy</option>
          <option value="Warning">Warning</option>
          <option value="Critical">Critical</option>
          <option value="Disabled">Disabled</option>
        </select>

        {/* View toggle */}
        <div className="flex rounded-lg border border-[#1e2a3b] bg-[#0a1628] p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('table')}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              viewMode === 'table' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:text-slate-300'
            )}
            title="Table view"
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('card')}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              viewMode === 'card' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:text-slate-300'
            )}
            title="Card view"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ─── Table View ──────────────────────────────────────────────────────── */}
      {viewMode === 'table' ? (
        <section className="overflow-hidden rounded-xl border border-[#1e2a3b] bg-[#0f1a2a]">
          {loading ? (
            <div className="flex items-center gap-2 p-8 text-[12px] text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading destinations…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16">
              <p className="text-sm font-semibold text-slate-300">No destinations yet</p>
              <p className="max-w-md text-center text-[12px] text-slate-500">
                Create a destination to send stream output to syslog or webhook endpoints.
              </p>
              <button
                type="button"
                onClick={openCreateSheet}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-500"
              >
                <Plus className="h-3.5 w-3.5" />
                New Destination
              </button>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="px-6 py-12 text-center text-[12px] text-slate-500">No destinations match filters.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#1e2a3b] bg-[#0a1628]">
                      <th className={TH}>Destination</th>
                      <th className={cn(TH, 'text-center')}>Capacity Usage</th>
                      <th className={TH}>EPS (Current)</th>
                      <th className={cn(TH, 'text-center')}>Success Rate</th>
                      <th className={TH}>Queue Depth</th>
                      <th className={TH}>Status</th>
                      <th className={cn(TH, 'text-right')}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row) => {
                      const rt = row.runtime
                      const { limitEps, thresholds: capThresholds } = extractCapacityConfig(row)
                      const dimmed = !row.enabled

                      return (
                        <Fragment key={row.id}>
                          <tr
                            className={cn(
                              'border-b border-[#1e2a3b] last:border-0 transition-colors hover:bg-[#0f1a2a]/80 cursor-pointer',
                              dimmed && 'opacity-55'
                            )}
                            onClick={() => setDrawerRow(row)}
                          >
                            {/* Destination */}
                            <td className={cn(TD, 'min-w-[180px]')}>
                              <div className="flex items-start gap-2">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#1e2a3b] bg-[#0a1628] text-[11px] font-bold text-slate-400">
                                  {row.name.slice(0, 2).toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[12px] font-semibold text-slate-100 truncate max-w-[160px]">{row.name}</div>
                                  <div className="mt-0.5 flex items-center gap-1.5">
                                    <TypeBadge type={row.destination_type} />
                                    <span className="text-[10px] text-slate-500">{rt.connectedStreams} route{rt.connectedStreams !== 1 ? 's' : ''}</span>
                                  </div>
                                </div>
                              </div>
                            </td>

                            {/* Capacity Usage */}
                            <td className={cn(TD, 'text-center')} onClick={(e) => e.stopPropagation()}>
                              <CapacityCell currentEps={rt.currentEps} capacityLimitEps={limitEps} thresholds={capThresholds} />
                            </td>

                            {/* EPS (Current) */}
                            <td className={TD}>
                              <div className="tabular-nums">
                                <div className="text-[13px] font-bold text-slate-100">{runtimeLoading ? '…' : formatEps(rt.currentEps)}</div>
                                {limitEps != null ? (
                                  <div className="text-[10px] text-slate-500">/ {limitEps.toLocaleString()} EPS</div>
                                ) : (
                                  <div className="text-[10px] text-slate-600">No limit</div>
                                )}
                              </div>
                            </td>

                            {/* Success Rate */}
                            <td className={cn(TD, 'text-center')} onClick={(e) => e.stopPropagation()}>
                              <div className="flex flex-col items-center gap-0.5">
                                <DonutChart successPct={rt.hasDeliveryActivity ? rt.successRatePct : null} size={44} strokeWidth={5} />
                              </div>
                            </td>

                            {/* Queue Depth */}
                            <td className={TD}>
                              <QueueDepthCell depth={null} />
                            </td>

                            {/* Status */}
                            <td className={TD}>
                              <HealthBadge health={rt.health} />
                            </td>

                            {/* Actions */}
                            <td className={cn(TD, 'text-right')} onClick={(e) => e.stopPropagation()}>
                              <RowKebabMenu
                                row={row}
                                onOpenDetail={() => setDrawerRow(row)}
                                onEdit={() => openEditSheet(row)}
                                onTest={() => void onTestRow(row)}
                                onToggleEnabled={(next) => void onToggleEnabled(row, next)}
                                onDelete={() => openDeleteFlow(row)}
                                testBusy={testBusyId === row.id}
                                actionBusy={actionBusyId === row.id}
                              />
                            </td>
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="border-t border-[#1e2a3b]">
                <Pagination
                  total={filteredRows.length}
                  page={page}
                  pageSize={pageSize}
                  onPage={setPage}
                  onPageSize={setPageSize}
                />
              </div>
            </>
          )}
        </section>
      ) : (
        /* ─── Card View ─────────────────────────────────────────────────────── */
        <>
          <DestinationCardView
            rows={filteredRows}
            onSelectRow={setDrawerRow}
            onEditRow={(row) => openEditSheet(row)}
            onDeleteRow={(row) => openDeleteFlow(row)}
            onTestRow={(row) => void onTestRow(row)}
          />
          {filteredRows.length > 0 && (
            <div className="rounded-xl border border-[#1e2a3b] bg-[#0f1a2a]">
              <Pagination
                total={filteredRows.length}
                page={page}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      {/* ─── Detail Drawer ────────────────────────────────────────────────────── */}
      {drawerRow && (
        <DestinationDetailDrawer
          row={drawerRow}
          onClose={() => setDrawerRow(null)}
          onEdit={() => { openEditSheet(drawerRow); setDrawerRow(null) }}
          lastTestResult={testResultById.get(drawerRow.id) ?? null}
        />
      )}

      {/* ─── Create / Edit Sheet ──────────────────────────────────────────────── */}
      {sheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/70 p-4 sm:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="my-auto flex max-h-[min(94vh,920px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#1e2a3b] bg-[#070f1c] shadow-2xl">

            {/* ── Dialog header ── */}
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#1e2a3b] px-6 py-5">
              <div>
                <h3 className="text-base font-semibold tracking-tight text-slate-100">
                  {sheetMode === 'create' ? 'Create Destination' : 'Edit Destination'}
                </h3>
                <p className="mt-1 text-[12px] text-slate-500">
                  Test connection with current fields, then save.
                </p>
              </div>
              <button type="button" onClick={closeSheet} className="rounded p-1 text-slate-500 hover:bg-[#1e2a3b] hover:text-slate-200" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {probeBanner && (
              <div
                role="status"
                aria-live="polite"
                className={cn(
                  'mx-6 mt-3 rounded-lg border px-4 py-3 text-[13px] leading-relaxed',
                  probeBanner.tone === 'success'
                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-100'
                    : 'border-red-500/40 bg-red-950/35 text-red-100',
                )}
              >
                {probeBanner.text}
              </div>
            )}

            {/* ── Body: form + right panel ── */}
            <form id="dest-form" onSubmit={(e) => void onSubmitSheet(e)} className="flex min-h-0 flex-1 overflow-hidden">

              {/* Left: form sections */}
              <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-6">

                {/* ── Section 1: Connection ── */}
                <section>
                  <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">1</span>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-200">Connection</p>
                      <p className="text-[11px] text-slate-500">Configure how Data Relay connects to your destination.</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="text-[13px] font-medium text-slate-400">
                        Name *
                        <input
                          required
                          className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 placeholder:text-slate-600 focus:border-violet-500/60 focus:outline-none"
                          value={form.name}
                          onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                        />
                      </label>
                      <label className="text-[13px] font-medium text-slate-400">
                        <span className="inline-flex items-center gap-1">
                          Type *
                          <HelpTooltip content={HELP_COPY.destinationVsRoute.content} ariaLabel="Destination type help" />
                        </span>
                        <select
                          className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 focus:border-violet-500/60 focus:outline-none"
                          value={form.destination_type}
                          onChange={(e) => {
                            const next = e.target.value as FormState['destination_type']
                            setForm((s) => {
                              const isSyslogChange = next !== s.destination_type && next !== 'WEBHOOK_POST'
                              return { ...s, destination_type: next, port: isSyslogChange ? defaultPortFor(next) : s.port }
                            })
                          }}
                        >
                          <option value="SYSLOG_UDP">SYSLOG_UDP</option>
                          <option value="SYSLOG_TCP">SYSLOG_TCP</option>
                          <option value="SYSLOG_TLS">SYSLOG_TLS</option>
                          <option value="WEBHOOK_POST">WEBHOOK_POST</option>
                        </select>
                      </label>
                    </div>

                    <p className="text-[12px] text-slate-500">
                      Protocol: <span className="font-semibold text-slate-300">{protocolLabel(form)}</span>
                    </p>

                    {form.destination_type === 'WEBHOOK_POST' ? (
                      <div className="space-y-4">
                        <label className="text-[13px] font-medium text-slate-400">
                          URL *
                          <input
                            required
                            className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 placeholder:text-slate-600"
                            value={form.url}
                            onChange={(e) => setForm((s) => ({ ...s, url: e.target.value }))}
                            placeholder="https://example.com/webhook"
                          />
                        </label>
                        <label className="text-[13px] font-medium text-slate-400">
                          Webhook Payload Mode
                          <select
                            className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100"
                            value={form.webhookPayloadMode}
                            onChange={(e) => setForm((s) => ({ ...s, webhookPayloadMode: e.target.value as WebhookPayloadMode }))}
                          >
                            <option value="SINGLE_EVENT_OBJECT">Single Event Object</option>
                            <option value="BATCH_JSON_ARRAY">Batch JSON Array</option>
                          </select>
                        </label>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <label className="text-[13px] font-medium text-slate-400">
                            Host *
                            <input
                              required
                              className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100"
                              value={form.host}
                              onChange={(e) => setForm((s) => ({ ...s, host: e.target.value }))}
                            />
                          </label>
                          <label className="text-[13px] font-medium text-slate-400">
                            Port *
                            <input
                              required
                              type="number"
                              min={1}
                              max={65535}
                              className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100"
                              value={form.port}
                              onChange={(e) => setForm((s) => ({ ...s, port: e.target.value }))}
                            />
                          </label>
                        </div>
                        {form.destination_type === 'SYSLOG_TLS' && (
                          <fieldset
                            data-testid="syslog-tls-section"
                            className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-4"
                          >
                            <legend className="px-1 text-[12px] font-semibold uppercase tracking-wide text-amber-300">
                              TLS Settings
                            </legend>
                            <label className="block text-[13px] font-medium text-slate-400">
                              Verification Mode
                              <select
                                className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100"
                                value={form.tlsVerifyMode}
                                onChange={(e) => setForm((s) => ({ ...s, tlsVerifyMode: e.target.value as TlsVerifyMode }))}
                              >
                                <option value="strict">strict (CA + hostname check)</option>
                                <option value="insecure_skip_verify">insecure_skip_verify (lab only)</option>
                              </select>
                            </label>
                            {form.tlsVerifyMode === 'insecure_skip_verify' && (
                              <p role="alert" data-testid="tls-insecure-warning" className="rounded-md border border-amber-500/40 bg-amber-900/40 px-3 py-2 text-[12px] text-amber-100">
                                Insecure mode disables certificate verification. Use only for lab/local testing.
                              </p>
                            )}
                            <div className="grid gap-3 sm:grid-cols-2">
                              {[
                                { label: 'CA Certificate Path (optional)', key: 'tlsCaCertPath' as const, placeholder: '/etc/gdc/tls/ca.pem' },
                                { label: 'SNI Server Name (optional)', key: 'tlsServerName' as const, placeholder: 'defaults to host' },
                                { label: 'Client Certificate Path (optional)', key: 'tlsClientCertPath' as const, placeholder: '/etc/gdc/tls/client.crt' },
                                { label: 'Client Key Path (optional)', key: 'tlsClientKeyPath' as const, placeholder: '/etc/gdc/tls/client.key' },
                              ].map(({ label, key, placeholder }) => (
                                <label key={key} className="text-[13px] font-medium text-slate-400">
                                  {label}
                                  <input
                                    placeholder={placeholder}
                                    className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 placeholder:text-slate-600"
                                    value={form[key]}
                                    onChange={(e) => setForm((s) => ({ ...s, [key]: e.target.value }))}
                                  />
                                </label>
                              ))}
                              {[
                                { label: 'Connect Timeout (s)', key: 'tlsConnectTimeout' as const },
                                { label: 'Write Timeout (s)', key: 'tlsWriteTimeout' as const },
                              ].map(({ label, key }) => (
                                <label key={key} className="text-[13px] font-medium text-slate-400">
                                  {label}
                                  <input
                                    type="number"
                                    min={1}
                                    step="1"
                                    className="mt-1.5 h-10 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100"
                                    value={form[key]}
                                    onChange={(e) => setForm((s) => ({ ...s, [key]: e.target.value }))}
                                  />
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        )}
                      </div>
                    )}

                    <label className="inline-flex items-center gap-2 text-[13px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
                        className="accent-violet-500"
                      />
                      <span className="inline-flex items-center gap-1">
                        Enable this destination
                        <HelpTooltip content={HELP_COPY.destinationEnabled.content} ariaLabel="Destination enabled help" />
                      </span>
                    </label>
                  </div>
                </section>

                <div className="border-t border-[#1e2a3b]" />

                {/* ── Section 2: Capacity & Monitoring ── */}
                <section>
                  <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">2</span>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-200">Capacity &amp; Monitoring</p>
                      <p className="text-[11px] text-slate-500">Define expected capacity for monitoring and alerting.</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {/* Maximum Throughput */}
                    <div>
                      <p className="mb-1.5 text-[13px] font-medium text-slate-400">
                        Maximum Throughput (EPS)
                        <HelpTooltip content="Expected maximum events per second. Used for capacity gauges and alerts only — does not throttle delivery." ariaLabel="Maximum throughput help" />
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={1000000}
                          step={1}
                          disabled={form.capacityUnlimited}
                          placeholder="5000"
                          className="h-10 w-40 rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 placeholder:text-slate-600 focus:border-violet-500/60 focus:outline-none disabled:opacity-40"
                          value={form.capacityLimitEps}
                          onChange={(e) => setForm((s) => ({ ...s, capacityLimitEps: e.target.value }))}
                        />
                        <select
                          disabled={form.capacityUnlimited}
                          className="h-10 rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 text-[13px] text-slate-100 focus:border-violet-500/60 focus:outline-none disabled:opacity-40"
                          value="EPS"
                          onChange={() => {}}
                        >
                          <option value="EPS">EPS</option>
                        </select>
                        <label className="inline-flex items-center gap-1.5 text-[12px] text-slate-400">
                          <input
                            type="checkbox"
                            checked={form.capacityUnlimited}
                            onChange={(e) => setForm((s) => ({ ...s, capacityUnlimited: e.target.checked, capacityLimitEps: e.target.checked ? '' : s.capacityLimitEps }))}
                            className="accent-violet-500"
                          />
                          Unlimited
                        </label>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-600">
                        {form.capacityUnlimited ? 'No capacity limit — excluded from overall capacity calculation.' : 'Expected maximum events per second that this destination can handle.'}
                      </p>
                      {!form.capacityUnlimited && form.capacityLimitEps.trim() !== '' && (() => {
                        const eps = parseFloat(form.capacityLimitEps)
                        if (!Number.isFinite(eps) || eps < 1 || eps > 1_000_000) {
                          return <p className="mt-1 text-[11px] text-red-400">Must be between 1 and 1,000,000.</p>
                        }
                        return null
                      })()}
                    </div>

                    {/* Warning / Critical Thresholds */}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-[13px] font-medium text-slate-400">
                          Warning Threshold (%)
                          <input
                            type="number"
                            min={1}
                            max={99}
                            step={1}
                            className={cn(
                              'mt-1.5 h-10 w-full rounded-md border bg-[#0a1628] px-3 text-[13px] text-slate-100 focus:outline-none',
                              (() => {
                                const w = parseInt(form.capacityWarningPct)
                                const c = parseInt(form.capacityCriticalPct)
                                return (isNaN(w) || w < 1 || w > 99 || (!isNaN(c) && w >= c))
                                  ? 'border-red-500/60 focus:border-red-500'
                                  : 'border-[#1e2a3b] focus:border-violet-500/60'
                              })(),
                            )}
                            value={form.capacityWarningPct}
                            onChange={(e) => setForm((s) => ({ ...s, capacityWarningPct: e.target.value }))}
                          />
                        </label>
                        <p className="mt-1 text-[11px] text-slate-600">When usage exceeds this, warning status is shown.</p>
                      </div>
                      <div>
                        <label className="text-[13px] font-medium text-slate-400">
                          Critical Threshold (%)
                          <input
                            type="number"
                            min={1}
                            max={100}
                            step={1}
                            className={cn(
                              'mt-1.5 h-10 w-full rounded-md border bg-[#0a1628] px-3 text-[13px] text-slate-100 focus:outline-none',
                              (() => {
                                const w = parseInt(form.capacityWarningPct)
                                const c = parseInt(form.capacityCriticalPct)
                                return (isNaN(c) || c < 1 || c > 100 || (!isNaN(w) && w >= c))
                                  ? 'border-red-500/60 focus:border-red-500'
                                  : 'border-[#1e2a3b] focus:border-violet-500/60'
                              })(),
                            )}
                            value={form.capacityCriticalPct}
                            onChange={(e) => setForm((s) => ({ ...s, capacityCriticalPct: e.target.value }))}
                          />
                        </label>
                        <p className="mt-1 text-[11px] text-slate-600">When usage exceeds this, critical status is shown.</p>
                      </div>
                    </div>

                    {/* Threshold validation error */}
                    {(() => {
                      const err = validateCapacityForm(form)
                      if (!err) return null
                      return (
                        <p className="rounded-md border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-300">
                          {err}
                        </p>
                      )
                    })()}

                    {/* Info banner */}
                    <div className="flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-[12px] text-sky-300">
                      <span className="mt-0.5 shrink-0 text-sky-400">ⓘ</span>
                      <span>Capacity settings are used for monitoring and alerting only. They do not throttle or limit delivery.</span>
                    </div>
                  </div>
                </section>

                <div className="border-t border-[#1e2a3b]" />

                {/* ── Section 3: Advanced ── */}
                <section>
                  <div className="mb-3 flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#1e2a3b] text-[11px] font-bold text-slate-500">3</span>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-500">Advanced <span className="text-[11px] font-normal text-slate-600">(Optional)</span></p>
                      <p className="text-[11px] text-slate-600">Additional connection settings.</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {['Timeout & Retry', 'Buffer & Performance', 'Compression', 'TLS / Security', 'Other Settings'].map((label) => (
                      <button
                        key={label}
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-md border border-[#1e2a3b] bg-[#0a1628] px-3 py-1.5 text-[11px] text-slate-500 hover:border-slate-600 hover:text-slate-400"
                        disabled
                      >
                        <ChevronRight className="h-3 w-3" />
                        {label}
                      </button>
                    ))}
                  </div>
                </section>

                {probeOk === false && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/40 px-4 py-3 text-[12px] leading-relaxed text-amber-100">
                    The last connection test did not succeed. You can still save; verify host, port, or URL and firewall rules.
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div className="hidden w-[296px] shrink-0 overflow-y-auto border-l border-[#1e2a3b] bg-[#070f1c] p-4 xl:block space-y-4">
                {(() => {
                  const warnPct = parseInt(form.capacityWarningPct) || 70
                  const critPct = parseInt(form.capacityCriticalPct) || 85
                  const configuredLimitEps = !form.capacityUnlimited && form.capacityLimitEps.trim() !== ''
                    ? parseFloat(form.capacityLimitEps)
                    : null
                  const runtimeEps = editingRow?.runtime.currentEps ?? null
                  // Current usage pct against configured limit
                  const liveUsagePct = configuredLimitEps != null && configuredLimitEps > 0 && runtimeEps != null
                    ? Math.round((runtimeEps / configuredLimitEps) * 100)
                    : null
                  const healthLabel =
                    form.capacityUnlimited ? 'No Limit'
                    : liveUsagePct == null ? '—'
                    : liveUsagePct >= critPct ? `${liveUsagePct}% Capacity`
                    : liveUsagePct >= warnPct ? `${liveUsagePct}% Capacity`
                    : `${liveUsagePct}% Capacity`
                  const healthColor =
                    form.capacityUnlimited ? 'text-slate-400 border-slate-600 bg-slate-700/30'
                    : liveUsagePct == null ? 'text-slate-500 border-slate-700 bg-transparent'
                    : liveUsagePct >= critPct ? 'text-red-300 border-red-500/40 bg-red-500/10'
                    : liveUsagePct >= warnPct ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
                    : 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                  const healthStatusLabel =
                    form.capacityUnlimited ? null
                    : liveUsagePct == null ? null
                    : liveUsagePct >= critPct ? 'Critical'
                    : liveUsagePct >= warnPct ? 'Warning'
                    : 'Healthy'

                  return (
                    <>
                      {/* ── Destination Summary ── */}
                      <div className="rounded-xl border border-[#1e2a3b] bg-[#0a1628] p-4">
                        <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Destination Summary</p>
                        <div className="space-y-2.5 text-[12px]">
                          {([
                            { label: 'Type', value: form.destination_type },
                            { label: 'Protocol', value: protocolLabel(form) },
                            {
                              label: 'Endpoint',
                              value: form.destination_type === 'WEBHOOK_POST'
                                ? (form.url.trim() || '—')
                                : (form.host.trim() && form.port.trim() ? `${form.host.trim()}:${form.port.trim()}` : '—'),
                            },
                            {
                              label: 'Status',
                              value: form.enabled ? 'Enabled' : 'Disabled',
                              color: form.enabled ? 'text-emerald-400' : 'text-slate-500',
                            },
                            {
                              label: 'Capacity',
                              value: form.capacityUnlimited
                                ? 'No limit'
                                : (configuredLimitEps != null ? `${configuredLimitEps.toLocaleString()} EPS` : '—'),
                            },
                            { label: 'Warning at', value: `${warnPct}%` },
                            { label: 'Critical at', value: `${critPct}%` },
                          ] as const).map(({ label, value, color }: { label: string; value: string; color?: string }) => (
                            <div key={label} className="flex items-start justify-between gap-2">
                              <span className="shrink-0 text-slate-500">{label}</span>
                              <span className={cn('text-right font-semibold', color ?? 'text-slate-200')}>{value}</span>
                            </div>
                          ))}
                          {/* Capacity Health Badge */}
                          {(healthStatusLabel != null || form.capacityUnlimited) && (
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <span className="shrink-0 text-slate-500">Health</span>
                              <span className={cn('inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold', healthColor)}>
                                {healthStatusLabel && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
                                {healthStatusLabel ? `${healthStatusLabel} · ${healthLabel}` : healthLabel}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* ── Capacity Recommendation ── */}
                      <CapacityRecommendationCard
                        currentEps={runtimeEps}
                        peakEps={null}
                        configuredLimitEps={configuredLimitEps}
                        unlimited={form.capacityUnlimited}
                        warningPct={warnPct}
                        criticalPct={critPct}
                        onApply={(eps) => setForm((s) => ({ ...s, capacityLimitEps: String(eps), capacityUnlimited: false }))}
                      />

                      {/* ── Test Connection Result ── */}
                      {probeResult && <TestConnectionResultCard result={probeResult} />}

                      {/* ── Capacity Gauge Preview ── */}
                      <CapacityGaugePreviewCard
                        warningPct={warnPct}
                        criticalPct={critPct}
                        limitEps={configuredLimitEps}
                        unlimited={form.capacityUnlimited}
                      />
                    </>
                  )
                })()}
              </div>

            </form>

            {/* ── Dialog footer ── */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[#1e2a3b] px-6 py-4">
              <button type="button" onClick={closeSheet} className="inline-flex h-10 items-center px-3 text-[13px] font-semibold text-slate-500 hover:text-slate-300">
                Cancel
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void onProbeForm()}
                  disabled={probeBusy}
                  className="inline-flex h-10 min-w-[140px] items-center justify-center gap-1.5 rounded-md border border-[#1e2a3b] bg-[#0a1628] px-4 text-[13px] font-semibold text-slate-200 hover:border-slate-500 disabled:opacity-60"
                >
                  {probeBusy ? 'Testing…' : '⊸ Test Connection'}
                </button>
                <button
                  form="dest-form"
                  type="submit"
                  disabled={saving || validateCapacityForm(form) !== null}
                  className="inline-flex h-10 min-w-[140px] items-center justify-center rounded-md bg-violet-600 px-4 text-[13px] font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
                >
                  {saving ? 'Saving…' : sheetMode === 'create' ? 'Save Destination' : 'Save Changes'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ─── Delete Blocked Toast ─────────────────────────────────────────────── */}
      {deleteBlocked && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 w-[min(100%,520px)] -translate-x-1/2 rounded-lg border border-amber-500/40 bg-amber-950/90 px-4 py-3 shadow-lg"
        >
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-100">{deleteBlocked.title}</p>
              <p className="mt-1 text-[12px] text-amber-200/90">{deleteBlocked.message}</p>
            </div>
            <button type="button" onClick={() => setDeleteBlocked(null)} className="shrink-0 text-amber-400" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ─── Test Result Toast ────────────────────────────────────────────────── */}
      {testBottomToast && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'fixed bottom-4 left-1/2 z-[60] w-[min(100%,560px)] -translate-x-1/2 rounded-lg border px-4 py-3 shadow-xl',
            testBottomToast.success
              ? 'border-emerald-500/50 bg-emerald-950/95'
              : 'border-red-500/50 bg-red-950/95',
          )}
        >
          <div className="flex gap-3">
            {testBottomToast.success ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-slate-100">
                Connection test · {testBottomToast.destinationName}
              </p>
              <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-slate-300">
                <span className={testBottomToast.success ? 'text-emerald-300' : 'text-red-300'}>
                  {testBottomToast.success ? 'Success' : 'Failed'}
                </span>
                {testBottomToast.latencyMs > 0 && (
                  <span className="text-slate-500"> · {testBottomToast.latencyMs.toFixed(1)} ms</span>
                )}
                <span className="text-slate-500"> · {testBottomToast.message}</span>
              </p>
              {testBottomToast.tlsDetail && (
                <p data-testid="tls-test-detail" className="mt-1 text-[11px] font-mono text-slate-400">
                  TLS · {testBottomToast.tlsDetail.verifyMode ?? '—'}
                  {testBottomToast.tlsDetail.negotiatedVersion ? ` · ${testBottomToast.tlsDetail.negotiatedVersion}` : ''}
                  {testBottomToast.tlsDetail.cipher ? ` · ${testBottomToast.tlsDetail.cipher}` : ''}
                  {testBottomToast.tlsDetail.serverName ? ` · sni=${testBottomToast.tlsDetail.serverName}` : ''}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={dismissTestToast}
              className="shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
              aria-label="Dismiss test result"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ─── Delete Confirm Modal ─────────────────────────────────────────────── */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-[#1e2a3b] bg-[#070f1c] p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-100">Delete destination</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
              This will permanently remove <span className="font-semibold text-slate-100">{deleteModal.row.name}</span>. Type the destination name to confirm.
            </p>
            <input
              value={deleteModal.confirm}
              onChange={(e) => setDeleteModal((m) => (m ? { ...m, confirm: e.target.value } : m))}
              placeholder="Destination name"
              className="mt-3 h-9 w-full rounded-md border border-[#1e2a3b] bg-[#0a1628] px-2 text-[12px] text-slate-100 placeholder:text-slate-600"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteModal(null)} className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-400 hover:text-slate-200">
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteBusy || deleteModal.confirm.trim() !== deleteModal.row.name.trim()}
                onClick={() => void executeDelete()}
                className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50 hover:bg-red-500"
              >
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// suppress warnings
void Link
void destinationDetailPath
