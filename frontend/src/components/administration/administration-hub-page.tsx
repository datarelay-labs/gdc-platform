import {
  Activity,
  ClipboardList,
  HardDrive,
  Lock,
  Network,
  Settings,
  Shield,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { canViewGovernance } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'

type HubCard = {
  title: string
  description: string
  path: string
  icon: typeof Settings
  testId: string
}

const BASE_HUB_CARDS: readonly HubCard[] = [
  {
    title: 'HTTPS',
    description: 'TLS listener, certificate SANs, and HTTP-to-HTTPS redirect.',
    path: SETTINGS_SECTION_PATH.https,
    icon: Shield,
    testId: 'admin-hub-https',
  },
  {
    title: 'User Management',
    description: 'Platform accounts, roles, and access status.',
    path: SETTINGS_SECTION_PATH.userManagement,
    icon: Users,
    testId: 'admin-hub-user-management',
  },
  {
    title: 'Password Management',
    description: 'Change operator passwords and credential policy.',
    path: SETTINGS_SECTION_PATH.passwordManagement,
    icon: Lock,
    testId: 'admin-hub-password-management',
  },
  {
    title: 'Network',
    description: 'Published HTTP/HTTPS ports and reverse-proxy apply workflow.',
    path: SETTINGS_SECTION_PATH.network,
    icon: Network,
    testId: 'admin-hub-network',
  },
  {
    title: 'Retention',
    description: 'Cleanup scheduler and per-category retention policy.',
    path: SETTINGS_SECTION_PATH.retention,
    icon: HardDrive,
    testId: 'admin-hub-retention',
  },
  {
    title: 'Audit',
    description: 'Platform audit trail and configuration change history.',
    path: SETTINGS_SECTION_PATH.audit,
    icon: ClipboardList,
    testId: 'admin-hub-audit',
  },
  {
    title: 'Backup',
    description: 'Export and import portable workspace configuration snapshots.',
    path: NAV_PATH.backup,
    icon: HardDrive,
    testId: 'admin-hub-backup',
  },
  {
    title: 'System Health',
    description: 'Operational health signals, maintenance readiness, and alerts.',
    path: SETTINGS_SECTION_PATH.systemHealth,
    icon: Activity,
    testId: 'admin-hub-system-health',
  },
] as const

const GOVERNANCE_OPS_CARD: HubCard = {
  title: 'Governance operations',
  description: 'Violations, quarantine, replay, and policy posture — not stream configuration.',
  path: NAV_PATH.governance,
  icon: Shield,
  testId: 'admin-hub-governance-operations',
}

export function AdministrationHubPage() {
  const hubCards = canViewGovernance() ? [GOVERNANCE_OPS_CARD, ...BASE_HUB_CARDS] : BASE_HUB_CARDS

  return (
    <div className="w-full min-w-0 space-y-5" data-testid="administration-hub-page">
      <div className="border-b border-slate-200/80 pb-4 dark:border-gdc-divider">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Administration</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">
          Platform settings, retention, audit, backup, and system health. Stream and delivery configuration lives under
          Data Sources and Delivery. Governance configuration is set in Stream Wizard / Route Processing.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Administration areas">
        {hubCards.map((card) => {
          const Icon = card.icon
          return (
            <Link
              key={card.testId}
              to={card.path}
              data-testid={card.testId}
              className={cn(
                'group flex flex-col rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm transition',
                'hover:border-violet-300/80 hover:shadow-md dark:border-gdc-border dark:bg-gdc-card dark:hover:border-violet-500/40',
              )}
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-slate-900 group-hover:text-violet-800 dark:text-slate-100 dark:group-hover:text-violet-200">
                    {card.title}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">{card.description}</p>
                </div>
              </div>
              <span className="mt-3 text-[11px] font-semibold text-violet-700 dark:text-violet-300">Open →</span>
            </Link>
          )
        })}
      </section>
    </div>
  )
}
