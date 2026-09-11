import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Edit2,
  FileSearch,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchGovernanceDashboardSummary,
  type GovernanceDashboardSummaryResponse,
} from '../../api/gdcGovernanceDashboard'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import {
  fetchGovernanceViolations,
  type GovernanceViolationEntry,
  type ViolationWindow,
} from '../../api/gdcGovernanceViolations'
import { fetchHealthOverview } from '../../api/gdcRuntimeHealth'
import { getOperationalSnapshot } from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { isOssReleaseMode } from '../../lib/feature-flags'
import { canEditPolicy } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'
import { formatPlatformRelative, formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'

const governanceCardClass =
  'rounded-xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm dark:border-[rgba(120,150,220,0.2)] dark:bg-[#111827]/95 dark:shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)] dark:ring-1 dark:ring-[rgba(120,150,220,0.1)]'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { policyStatusBadgeClass, policyStatusLabel } from './policy-lifecycle'

const WINDOW_OPTIONS: ViolationWindow[] = ['24h', '7d', '30d']

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function formatRelativeTime(iso: string): string {
  return formatPlatformRelative(iso)
}

function formatUpdatedAt(iso: string): string {
  return formatTimestampWithResolvedTimezone(iso)
}

function deriveOverallRiskPosture(summary: GovernanceDashboardSummaryResponse | null): 'healthy' | 'warning' | 'critical' {
  if (!summary) return 'healthy'
  const { risk, policy_health: health } = summary
  if (risk.critical > 0 || health.critical > 0) return 'critical'
  if (risk.high > 0 || risk.medium > 0 || health.warning > 0) return 'warning'
  return 'healthy'
}

function postureMeta(posture: 'healthy' | 'warning' | 'critical') {
  if (posture === 'critical') {
    return {
      label: 'Critical',
      description: 'Immediate attention required.',
      icon: ShieldAlert,
      iconBg: 'bg-red-500/15 text-red-400',
      valueClass: 'text-red-400',
    }
  }
  if (posture === 'warning') {
    return {
      label: 'Warning',
      description: 'Monitor and address important issues.',
      icon: AlertTriangle,
      iconBg: 'bg-amber-500/15 text-amber-400',
      valueClass: 'text-amber-300',
    }
  }
  return {
    label: 'Healthy',
    description: 'Policy posture is within normal bounds.',
    icon: CheckCircle2,
    iconBg: 'bg-emerald-500/15 text-emerald-400',
    valueClass: 'text-emerald-400',
  }
}

function trendFootnote(delta: number, positiveIsBad = true): { text: string; className: string } {
  if (delta === 0) {
    return { text: 'No change vs last 24h', className: 'text-slate-500 dark:text-gdc-muted' }
  }
  const up = delta > 0
  const bad = positiveIsBad ? up : !up
  return {
    text: `${up ? '↑' : '↓'} ${formatCount(Math.abs(delta))} vs last 24h`,
    className: bad ? 'text-red-400' : 'text-emerald-400',
  }
}

function severityBadgeClass(severity: string): string {
  const s = severity.toUpperCase()
  if (s === 'CRITICAL' || s === 'HIGH') {
    return 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30'
  }
  if (s === 'MEDIUM') {
    return 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
  }
  return 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
}

function severityDisplayLabel(severity: string): string {
  const s = severity.toUpperCase()
  if (s === 'HIGH') return 'High'
  if (s === 'MEDIUM') return 'Medium'
  if (s === 'LOW') return 'Low'
  if (s === 'CRITICAL') return 'Critical'
  return severity
}

function policyTypeLabel(category: string): string {
  switch (category) {
    case 'DATA_PROTECTION':
      return 'Protection'
    case 'AI_GOVERNANCE':
      return 'Detection'
    case 'COMPLIANCE':
      return 'Prevention'
    case 'CUSTOM':
      return 'Classification'
    default:
      return category.replace(/_/g, ' ')
  }
}

function violationTitle(v: GovernanceViolationEntry): string {
  const stream = v.stream_name || 'Stream'
  const policy = v.policy_name || 'Policy'
  return `${policy} in ${stream}`
}

type SummaryKpiCardProps = {
  label: string
  value: string
  footnote: { text: string; className: string }
  icon: typeof Shield
  iconBg: string
  testId: string
  to?: string
}

function SummaryKpiCard({ label, value, footnote, icon: Icon, iconBg, testId, to }: SummaryKpiCardProps) {
  const body = (
    <div className={cn(governanceCardClass, 'flex min-h-[7.25rem] flex-col')} data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium text-slate-400">{label}</p>
        <span className={cn('inline-flex rounded-lg p-1.5', iconBg)} aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2 text-[1.75rem] font-bold tabular-nums leading-none tracking-tight text-slate-50">{value}</p>
      <p className={cn('mt-auto pt-2 text-[11px] font-medium', footnote.className)}>{footnote.text}</p>
    </div>
  )
  if (to) {
    return (
      <Link to={to} className="block transition-opacity hover:opacity-90">
        {body}
      </Link>
    )
  }
  return body
}

function WhatHappenedCard({
  count,
  title,
  description,
  tone,
  testId,
  to,
}: {
  count: number | null
  title: string
  description: string
  tone: 'sky' | 'amber' | 'violet' | 'orange'
  testId: string
  to?: string
}) {
  const toneClass = {
    sky: 'text-sky-400',
    amber: 'text-amber-400',
    violet: 'text-violet-400',
    orange: 'text-orange-400',
  }[tone]
  const body = (
    <div className={cn(governanceCardClass, 'flex min-h-[5.5rem] flex-col')} data-testid={testId}>
      <p className={cn('text-[1.5rem] font-bold tabular-nums leading-none', count == null ? 'text-slate-500' : toneClass)}>
        {count == null ? '—' : formatCount(count)}
      </p>
      <p className="mt-2 text-[12px] font-semibold text-slate-100">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-gdc-muted">
        {count == null ? 'Data unavailable' : description}
      </p>
    </div>
  )
  if (to) {
    return (
      <Link to={to} className="block transition-opacity hover:opacity-90">
        {body}
      </Link>
    )
  }
  return body
}

export function GovernanceDashboardPage() {
  const [summary, setSummary] = useState<GovernanceDashboardSummaryResponse | null>(null)
  const [violations, setViolations] = useState<GovernanceViolationEntry[]>([])
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [operationalIssues, setOperationalIssues] = useState<{
    noDataStreams: number
    lowVolumeStreams: number
    schemaDriftCount: number | null
    destinationCapacityWarnings: number
  }>({
    noDataStreams: 0,
    lowVolumeStreams: 0,
    schemaDriftCount: null,
    destinationCapacityWarnings: 0,
  })
  const [window, setWindow] = useState<ViolationWindow>('24h')
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const policiesLink = isOssReleaseMode() ? NAV_PATH.governanceApprovals : NAV_PATH.governanceDataProtection
  const canEdit = canEditPolicy()

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const summaryResp = await fetchGovernanceDashboardSummary()
      setSummary(summaryResp)
    } catch (e) {
      setSummary(null)
      setSummaryError(e instanceof Error ? e.message : 'Failed to load governance dashboard summary')
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [violationsResp, policiesResp] = await Promise.all([
        fetchGovernanceViolations({ window, limit: 5, status: 'OPEN' }),
        fetchGovernancePolicies(),
      ])
      setViolations(violationsResp?.violations ?? [])
      setPolicies((policiesResp?.policies ?? []).slice(0, 5))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load governance dashboard')
    } finally {
      setLoading(false)
    }
  }, [window])

  const loadOperationalIssues = useCallback(async () => {
    try {
      const [health, snapshot] = await Promise.all([
        fetchHealthOverview({ window: '24h' }).catch(() => null),
        getOperationalSnapshot().catch(() => null),
      ])
      setOperationalIssues(deriveGovernanceOperationalIssues(health, null, [], snapshot))
    } catch {
      /* optional enrichment — ignore failures */
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadSummary(), loadOperationalIssues()])
  }, [load, loadSummary, loadOperationalIssues])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadSummary()
    void loadOperationalIssues()
  }, [loadSummary, loadOperationalIssues])

  const posture = deriveOverallRiskPosture(summary)
  const postureInfo = postureMeta(posture)

  const kpiCards = useMemo(() => {
    const snap = summary?.compliance_snapshot
    const openViolations = summary?.open_violations ?? 0
    const criticalViolations = summary?.risk.critical ?? 0
    const quarantined = summary?.quarantined_events ?? 0
    const pendingApprovals = summary?.pending_approvals ?? 0

    return [
      {
        id: 'overall-risk',
        label: 'Overall Risk',
        value: postureInfo.label,
        footnote: { text: postureInfo.description, className: 'text-slate-500 dark:text-gdc-muted' },
        icon: postureInfo.icon,
        iconBg: postureInfo.iconBg,
        testId: 'dashboard-kpi-overall-risk',
      },
      {
        id: 'open-violations',
        label: 'Open Violations',
        value: formatCount(openViolations),
        footnote: trendFootnote(snap?.violations_24h ?? 0, true),
        icon: ShieldAlert,
        iconBg: 'bg-violet-500/15 text-violet-400',
        testId: 'dashboard-kpi-violations',
        to: NAV_PATH.governanceViolations,
      },
      {
        id: 'critical-violations',
        label: 'Critical Violations',
        value: formatCount(criticalViolations),
        footnote: trendFootnote(Math.min(criticalViolations, snap?.violations_24h ?? 0), true),
        icon: AlertTriangle,
        iconBg: 'bg-red-500/15 text-red-400',
        testId: 'dashboard-kpi-critical-violations',
        to: NAV_PATH.governanceViolations,
      },
      {
        id: 'quarantined-events',
        label: 'Quarantined Events',
        value: formatCount(quarantined),
        footnote: trendFootnote(snap?.quarantines_24h ?? 0, false),
        icon: Lock,
        iconBg: 'bg-emerald-500/15 text-emerald-400',
        testId: 'dashboard-kpi-quarantine',
        to: NAV_PATH.governanceQuarantine,
      },
      {
        id: 'pending-approvals',
        label: 'Pending Approvals',
        value: formatCount(pendingApprovals),
        footnote: trendFootnote(summary?.policies_in_review ?? 0, true),
        icon: ClipboardCheck,
        iconBg: 'bg-sky-500/15 text-sky-400',
        testId: 'dashboard-kpi-pending-approvals',
        to: NAV_PATH.governanceApprovals,
      },
    ] as const
  }, [summary, postureInfo])

  const recommendedActions = useMemo(() => {
    const critical = summary?.risk.critical ?? 0
    const pending = summary?.pending_approvals ?? 0
    const quarantined = summary?.quarantined_events ?? 0
    const schemaChanges = operationalIssues.schemaDriftCount
    return [
      {
        label: `${formatCount(critical)} Critical 위반을 검토하세요`,
        to: NAV_PATH.governanceViolations,
        tone: 'red' as const,
        testId: 'gov-action-critical-violations',
      },
      {
        label: `${formatCount(pending)} Pending 승인을 처리하세요`,
        to: NAV_PATH.governanceApprovals,
        tone: 'orange' as const,
        testId: 'gov-action-pending-approvals',
      },
      {
        label: `${formatCount(quarantined)} 격리 이벤트를 검토하세요`,
        to: NAV_PATH.governanceQuarantine,
        tone: 'blue' as const,
        testId: 'gov-action-quarantine',
      },
      {
        label: schemaChanges != null ? `${formatCount(schemaChanges)} 스키마 변경을 확인하세요` : '스키마 변경 데이터 조회 불가',
        to: `${NAV_PATH.streams}?filter=schema-drift`,
        tone: 'green' as const,
        testId: 'gov-action-schema-drift',
      },
    ]
  }, [summary, operationalIssues.schemaDriftCount])

  const quickActions = [
    {
      title: 'Policy Builder',
      description: 'Create and manage policies',
      to: policiesLink,
      icon: Shield,
      iconBg: 'bg-violet-500/15 text-violet-400',
      testId: 'gov-quick-policy-builder',
    },
    {
      title: 'Violation Center',
      description: 'Review and triage violations',
      to: NAV_PATH.governanceViolations,
      icon: ShieldAlert,
      iconBg: 'bg-red-500/15 text-red-400',
      testId: 'gov-quick-violations',
    },
    {
      title: 'Quarantine Center',
      description: 'Manage quarantined events',
      to: NAV_PATH.governanceQuarantine,
      icon: Lock,
      iconBg: 'bg-emerald-500/15 text-emerald-400',
      testId: 'gov-quick-quarantine',
    },
    {
      title: 'Approval Center',
      description: 'Review pending approvals',
      to: NAV_PATH.governanceApprovals,
      icon: ClipboardCheck,
      iconBg: 'bg-sky-500/15 text-sky-400',
      testId: 'gov-quick-approvals',
    },
  ] as const

  const notificationCount = summary?.notification_failures ?? 0

  return (
    <div className="space-y-4" data-testid="governance-dashboard-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.35rem] font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Governance Overview
          </h1>
          <p className="mt-0.5 text-[13px] text-slate-500 dark:text-gdc-muted">
            Policy posture, violations, and compliance at a glance.
          </p>
          <p className="mt-1.5 text-[12px] text-slate-500 dark:text-gdc-muted">
            Stream and route processing configuration is set in Stream Wizard / Route Processing.{' '}
            <Link
              to={NAV_PATH.governanceWorkspace}
              className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
              data-testid="gov-dashboard-workspace-link"
            >
              Open Governance Workspace
            </Link>{' '}
            for a read-only inheritance overview.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={NAV_PATH.governanceNotifications}
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/80 bg-white text-slate-600 transition hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-300 dark:hover:bg-gdc-rowHover"
            aria-label="Governance notifications"
            data-testid="gov-dashboard-notifications"
          >
            <Bell className="h-4 w-4" />
            {notificationCount > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                {notificationCount > 9 ? '9+' : notificationCount}
              </span>
            ) : null}
          </Link>
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200/80 bg-white px-2.5 py-1.5 text-[12px] dark:border-gdc-border dark:bg-gdc-card">
            <span className="sr-only">Time window</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as ViolationWindow)}
              className="cursor-pointer bg-transparent text-slate-700 outline-none dark:text-slate-200"
              data-testid="gov-dashboard-window"
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w === '24h' ? 'Last 24 Hours' : w === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loading || summaryLoading}
            data-testid="dashboard-refresh"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/80 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-300 dark:hover:bg-gdc-rowHover"
            aria-label="Refresh governance dashboard"
          >
            {loading || summaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {error ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          data-testid="governance-dashboard-error"
        >
          {error}
        </p>
      ) : null}

      {summaryError ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="governance-dashboard-summary-error"
          role="alert"
        >
          {summaryError}
        </p>
      ) : null}

      <section aria-label="Governance KPI summary" data-testid="dashboard-kpi-strip" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpiCards.map((kpi) => (
          <SummaryKpiCard
            key={kpi.id}
            label={kpi.label}
            value={kpi.value}
            footnote={kpi.footnote}
            icon={kpi.icon}
            iconBg={kpi.iconBg}
            testId={kpi.testId}
            to={'to' in kpi ? kpi.to : undefined}
          />
        ))}
      </section>

      <section aria-label="What happened summary" data-testid="governance-what-happened">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
            What Happened? <span className="font-normal text-slate-500 dark:text-gdc-muted">(요약)</span>
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <WhatHappenedCard
            count={operationalIssues.noDataStreams}
            title="No Data Streams"
            description="스트림에서 데이터가 감지되지 않았습니다."
            tone="sky"
            testId="gov-issue-no-data"
          />
          <WhatHappenedCard
            count={operationalIssues.lowVolumeStreams}
            title="Low Volume Streams"
            description="평소 대비 데이터 전송량이 낮습니다."
            tone="amber"
            testId="gov-issue-low-volume"
          />
          <WhatHappenedCard
            count={operationalIssues.schemaDriftCount}
            title="Schema Drift Detected"
            description="스키마 변경이 감지되었습니다."
            tone="violet"
            testId="gov-issue-schema-drift"
            to={`${NAV_PATH.streams}?filter=schema-drift`}
          />
          <WhatHappenedCard
            count={operationalIssues.destinationCapacityWarnings}
            title="Destination Warnings"
            description="목적지 용량 또는 오류 경고가 있습니다."
            tone="orange"
            testId="gov-issue-destination-warnings"
          />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-12">
        <section
          className={cn(governanceCardClass, 'lg:col-span-7')}
          data-testid="dashboard-recent-activity"
          aria-label="Recent violations"
        >
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
              Recent Violations <span className="font-normal text-slate-500 dark:text-gdc-muted">(최근 위반 요약)</span>
            </h2>
            <Link
              to={NAV_PATH.governanceViolations}
              className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300"
            >
              View All
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className={opTable} data-testid="gov-recent-violations-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Violation</th>
                  <th className={opTh}>Policy</th>
                  <th className={opTh}>Severity</th>
                  <th className={opTh}>Time</th>
                  <th className={opTh}>Action</th>
                </tr>
              </thead>
              <tbody>
                {violations.length === 0 && !loading ? (
                  <tr className={opTr}>
                    <td className={opTd} colSpan={5}>
                      No recent violations in this window.
                    </td>
                  </tr>
                ) : (
                  violations.map((v) => (
                    <tr key={v.id} className={opTr} data-testid={`gov-violation-row-${v.id}`}>
                      <td className={cn(opTd, 'font-medium text-slate-900 dark:text-slate-100')}>{violationTitle(v)}</td>
                      <td className={opTd}>{v.policy_name}</td>
                      <td className={opTd}>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', severityBadgeClass(v.severity))}>
                          {severityDisplayLabel(v.severity)}
                        </span>
                      </td>
                      <td className={cn(opTd, 'whitespace-nowrap text-slate-500 dark:text-gdc-muted')}>
                        {formatRelativeTime(v.event_time)}
                      </td>
                      <td className={opTd}>
                        <Link
                          to={`${NAV_PATH.governanceViolations}?id=${encodeURIComponent(v.id)}`}
                          className="inline-flex rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
                          data-testid={`gov-investigate-${v.id}`}
                        >
                          Investigate
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={cn(governanceCardClass, 'lg:col-span-5')} data-testid="governance-recommended-actions">
          <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
            What Should I Do? <span className="font-normal text-slate-500 dark:text-gdc-muted">(권장 조치)</span>
          </h2>
          <ul className="mt-3 space-y-2">
            {recommendedActions.map((action) => {
              const toneClass =
                action.tone === 'red'
                  ? 'bg-red-500/10 text-red-400'
                  : action.tone === 'orange'
                    ? 'bg-orange-500/10 text-orange-400'
                    : action.tone === 'blue'
                      ? 'bg-sky-500/10 text-sky-400'
                      : 'bg-emerald-500/10 text-emerald-400'
              return (
                <li key={action.testId}>
                  <Link
                    to={action.to}
                    data-testid={action.testId}
                    className="group flex items-center gap-3 rounded-lg border border-slate-200/60 bg-slate-50/40 px-3 py-2.5 transition hover:border-violet-500/30 hover:bg-violet-500/[0.04] dark:border-gdc-border dark:bg-gdc-section/40 dark:hover:border-violet-500/30"
                  >
                    <span className={cn('inline-flex rounded-lg p-2', toneClass)} aria-hidden>
                      {action.tone === 'red' ? (
                        <AlertTriangle className="h-4 w-4" />
                      ) : action.tone === 'orange' ? (
                        <ClipboardCheck className="h-4 w-4" />
                      ) : action.tone === 'blue' ? (
                        <Lock className="h-4 w-4" />
                      ) : (
                        <FileSearch className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] font-medium text-slate-800 dark:text-slate-100">{action.label}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-violet-400" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <div className="grid gap-3 lg:grid-cols-12">
        <section className={cn(governanceCardClass, 'lg:col-span-8')} data-testid="dashboard-policy-health" aria-label="Policy list">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">
              Policy List <span className="font-normal text-slate-500 dark:text-gdc-muted">(정책 목록)</span>
            </h2>
            {canEdit ? (
              <Link
                to={policiesLink}
                className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
                data-testid="gov-new-policy"
              >
                <Plus className="h-3.5 w-3.5" />
                New Policy
              </Link>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className={opTable} data-testid="gov-policy-list-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Policy Name</th>
                  <th className={opTh}>Type</th>
                  <th className={opTh}>Applies To</th>
                  <th className={opTh}>Status</th>
                  <th className={opTh}>Last Updated</th>
                  <th className={opTh}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {policies.length === 0 && !loading ? (
                  <tr className={opTr}>
                    <td className={opTd} colSpan={6}>
                      No policies configured yet.
                    </td>
                  </tr>
                ) : (
                  policies.map((policy) => (
                    <tr key={policy.id} className={opTr} data-testid={`gov-policy-row-${policy.id}`}>
                      <td className={cn(opTd, 'font-semibold text-slate-900 dark:text-slate-100')}>{policy.name}</td>
                      <td className={opTd}>{policyTypeLabel(policy.category)}</td>
                      <td className={opTd}>
                        {policy.assigned_stream_count} Stream{policy.assigned_stream_count === 1 ? '' : 's'}
                      </td>
                      <td className={opTd}>
                        <span
                          className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', policyStatusBadgeClass(policy.status))}
                        >
                          {policyStatusLabel(policy.status)}
                        </span>
                      </td>
                      <td className={cn(opTd, 'whitespace-nowrap text-slate-500 dark:text-gdc-muted')}>
                        {formatUpdatedAt(policy.updated_at)}
                      </td>
                      <td className={opTd}>
                        <div className="flex items-center gap-1">
                          <Link
                            to={policiesLink}
                            className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                            aria-label={`Edit ${policy.name}`}
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            type="button"
                            className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                            aria-label={`Copy ${policy.name}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                            aria-label={`More actions for ${policy.name}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 border-t border-slate-200/70 pt-2 dark:border-gdc-border">
            <Link to={policiesLink} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300">
              View all policies →
            </Link>
          </div>
        </section>

        <section className={cn(governanceCardClass, 'lg:col-span-4')} data-testid="governance-quick-actions">
          <h2 className="text-[14px] font-semibold text-slate-900 dark:text-slate-100">Quick Actions</h2>
          <ul className="mt-3 space-y-2">
            {quickActions.map((action) => {
              const Icon = action.icon
              return (
                <li key={action.testId}>
                  <Link
                    to={action.to}
                    data-testid={action.testId}
                    className="group flex items-center gap-3 rounded-lg border border-slate-200/60 px-3 py-2.5 transition hover:border-violet-500/30 hover:bg-violet-500/[0.04] dark:border-gdc-border dark:hover:border-violet-500/30"
                  >
                    <span className={cn('inline-flex rounded-lg p-2', action.iconBg)} aria-hidden>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">{action.title}</span>
                      <span className="block text-[11px] text-slate-500 dark:text-gdc-muted">{action.description}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-violet-400" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      <div className="hidden" aria-hidden data-testid="dashboard-risk-overview">
        {summary ? `${summary.risk.critical}-${summary.risk.high}` : '0-0'}
      </div>
      <div className="hidden" aria-hidden data-testid="dashboard-compliance-snapshot">
        {summary ? `${summary.compliance_snapshot.violations_24h}` : '0'}
      </div>
    </div>
  )
}
