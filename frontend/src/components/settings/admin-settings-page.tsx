import {
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  Lock,
  Package,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  createAdminUser,
  deleteAdminUser,
  downloadAdminSupportBundle,
  getAdminHttpsSettings,
  getAdminSystemInfo,
  getAuthWhoAmI,
  listAdminUsers,
  postAdminPasswordChange,
  putAdminHttpsSettings,
  updateAdminUser,
  type HttpsSettingsDto,
  type PlatformUserDto,
  type SystemInfoDto,
} from '../../api/gdcAdmin'
import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { isDevValidationLabUiEnabled } from '../../lib/feature-flags'
import { gdcUi, isAdminUiReadOnly, readAdminUiRole } from '../../lib/gdc-ui-tokens'
import { canViewGovernance } from '../../lib/governance-rbac'
import { NAV_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { AdminDevValidationPanel } from './admin-dev-validation-panel'
import { AdminDisplayTimezoneSettings } from './admin-display-timezone-settings'
import { AdminMaintenanceCenter } from './admin-maintenance-center'
import { AdminNetworkSettingsPage } from './admin-network-settings-page'
import { AdminOperationalDashboard } from './admin-settings-operational'
import { passwordsMatch, validateNewPassword } from './admin-settings-validation'
import {
  httpsDraftFromSettings,
  readAdminSettingsSnapshot,
  writeAdminSettingsSnapshot,
} from './admin-settings-session-cache'

const VALID_DAY_OPTIONS = [30, 90, 180, 365, 730] as const

function validDaySelectOptions(current: number): number[] {
  const s = new Set<number>([...VALID_DAY_OPTIONS, current])
  return [...s].sort((a, b) => a - b)
}

function roleBadgeClass(role: string) {
  if (role === 'ADMINISTRATOR') {
    return 'border-violet-500/25 bg-violet-500/[0.08] text-violet-800 dark:border-violet-500/35 dark:bg-violet-500/12 dark:text-violet-100/90'
  }
  if (role === 'OPERATOR') {
    return 'border-sky-500/25 bg-sky-500/[0.08] text-sky-900 dark:border-sky-500/35 dark:bg-sky-500/12 dark:text-sky-100/90'
  }
  return 'border-slate-300/80 bg-slate-100 text-slate-700 dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:text-slate-200'
}

function roleLabel(role: string) {
  if (role === 'ADMINISTRATOR') return 'Administrator'
  if (role === 'OPERATOR') return 'Operator'
  return 'Viewer'
}

function formatTs(iso: string | null) {
  if (!iso) return '—'
  return formatTimestampWithResolvedTimezone(iso)
}

function formatUptimeSeconds(sec: number | null | undefined) {
  if (sec == null || Number.isNaN(sec)) return '—'
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

type UserFormState = { username: string; password: string; role: string; status: string }

export function AdminSettingsPage() {
  const navigate = useNavigate()
  const sessionSnapshot = readAdminSettingsSnapshot()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [https, setHttps] = useState<HttpsSettingsDto | null>(() => sessionSnapshot?.https ?? null)
  const [httpsDraft, setHttpsDraft] = useState<{
    enabled: boolean
    certificate_ip_addresses: string
    certificate_dns_names: string
    redirect_http_to_https: boolean
    certificate_valid_days: number
    regenerate_certificate: boolean
  } | null>(() => sessionSnapshot?.httpsDraft ?? null)
  const [users, setUsers] = useState<PlatformUserDto[]>(() => sessionSnapshot?.users ?? [])
  const [pageMsg, setPageMsg] = useState<string | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwUser, setPwUser] = useState('admin')
  const [showPw, setShowPw] = useState(false)

  const [userModal, setUserModal] = useState<'create' | 'edit' | null>(null)
  const [editingUser, setEditingUser] = useState<PlatformUserDto | null>(null)
  const [userForm, setUserForm] = useState<UserFormState>({ username: '', password: '', role: 'VIEWER', status: 'ACTIVE' })

  const [systemOpen, setSystemOpen] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfoDto | null>(null)
  const [systemFooter, setSystemFooter] = useState<SystemInfoDto | null>(() => sessionSnapshot?.systemFooter ?? null)
  const [opReload, setOpReload] = useState(0)
  const [backendRole, setBackendRole] = useState<import('../../auth/session').SessionRole | null>(readAdminUiRole())

  const readOnly = isAdminUiReadOnly() || backendRole === 'VIEWER'
  const isOperator = (backendRole ?? readAdminUiRole()) === 'OPERATOR'

  const refreshAll = useCallback(async (options?: { background?: boolean }) => {
    setLoadError(null)
    try {
      const [h, u, sys, who] = await Promise.all([
        getAdminHttpsSettings(),
        listAdminUsers(),
        getAdminSystemInfo(),
        getAuthWhoAmI().catch(() => null),
      ])
      const draft = httpsDraftFromSettings(h)
      setHttps(h)
      setHttpsDraft(draft)
      setUsers(u)
      setSystemFooter(sys)
      writeAdminSettingsSnapshot({ https: h, httpsDraft: draft, users: u, systemFooter: sys })
      if (who && (who.role === 'ADMINISTRATOR' || who.role === 'OPERATOR' || who.role === 'VIEWER')) {
        setBackendRole(who.role)
      }
      if (!options?.background) {
        setOpReload((n) => n + 1)
      }
    } catch (e) {
      if (!options?.background) {
        setLoadError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [])

  useEffect(() => {
    void refreshAll({ background: sessionSnapshot != null })
  }, [refreshAll]) // eslint-disable-line react-hooks/exhaustive-deps

  const httpsDirty = useMemo(() => {
    if (!https || !httpsDraft) return false
    const ips = httpsDraft.certificate_ip_addresses
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const dns = httpsDraft.certificate_dns_names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const baseDirty =
      https.enabled !== httpsDraft.enabled ||
      https.redirect_http_to_https !== httpsDraft.redirect_http_to_https ||
      https.certificate_valid_days !== httpsDraft.certificate_valid_days ||
      https.certificate_ip_addresses.join(',') !== ips.join(',') ||
      https.certificate_dns_names.join(',') !== dns.join(',')
    const regenDirty = httpsDraft.regenerate_certificate === false
    return baseDirty || regenDirty
  }, [https, httpsDraft])

  const activeAdminCount = useMemo(
    () => users.filter((u) => u.role === 'ADMINISTRATOR' && u.status === 'ACTIVE').length,
    [users],
  )

  const userStats = useMemo(() => {
    const total = users.length
    const active = users.filter((u) => u.status === 'ACTIVE').length
    const admins = users.filter((u) => u.role === 'ADMINISTRATOR').length
    const operators = users.filter((u) => u.role === 'OPERATOR').length
    const viewers = users.filter((u) => u.role === 'VIEWER').length
    return { total, active, admins, operators, viewers }
  }, [users])

  const onSaveHttps = async () => {
    if (!httpsDraft) return
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      const ips = httpsDraft.certificate_ip_addresses
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const dns = httpsDraft.certificate_dns_names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await putAdminHttpsSettings({
        enabled: httpsDraft.enabled,
        certificate_ip_addresses: ips,
        certificate_dns_names: dns,
        redirect_http_to_https: httpsDraft.redirect_http_to_https,
        certificate_valid_days: httpsDraft.certificate_valid_days,
        regenerate_certificate: httpsDraft.regenerate_certificate,
      })
      const extra =
        res.proxy_fallback_to_http && !res.proxy_https_effective
          ? ' The proxy fell back to HTTP-only so access stays available.'
          : ''
      const restart = res.restart_required ? ' Manual reverse-proxy reload may still be required.' : ''
      setPageMsg(`${res.message}${extra}${restart}`)
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onChangePassword = async () => {
    setPageErr(null)
    setPageMsg(null)
    const v = validateNewPassword(pwNew)
    if (v) {
      setPageErr(v)
      return
    }
    if (!passwordsMatch(pwNew, pwConfirm)) {
      setPageErr('New password and confirmation do not match.')
      return
    }
    setBusy(true)
    try {
      await postAdminPasswordChange({
        username: pwUser.trim(),
        current_password: pwCurrent,
        new_password: pwNew,
        confirm_password: pwConfirm,
      })
      setPageMsg('Password updated.')
      setPwCurrent('')
      setPwNew('')
      setPwConfirm('')
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openCreateUser = () => {
    setUserForm({ username: '', password: '', role: 'VIEWER', status: 'ACTIVE' })
    setEditingUser(null)
    setUserModal('create')
  }

  const openEditUser = (u: PlatformUserDto) => {
    setEditingUser(u)
    setUserForm({ username: u.username, password: '', role: u.role, status: u.status })
    setUserModal('edit')
  }

  const onSaveUser = async () => {
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      if (userModal === 'create') {
        const err = validateNewPassword(userForm.password)
        if (err) {
          setPageErr(err)
          return
        }
        await createAdminUser({
          username: userForm.username.trim(),
          password: userForm.password,
          role: userForm.role,
        })
        setPageMsg('User created.')
      } else if (editingUser) {
        const body: { password?: string; role?: string; status?: string } = {}
        if (userForm.password.trim()) {
          const err = validateNewPassword(userForm.password)
          if (err) {
            setPageErr(err)
            return
          }
          body.password = userForm.password
        }
        if (userForm.role !== editingUser.role) body.role = userForm.role
        if (userForm.status !== editingUser.status) body.status = userForm.status
        if (Object.keys(body).length === 0) {
          setPageMsg('No changes to save.')
        } else {
          await updateAdminUser(editingUser.id, body)
          setPageMsg('User updated.')
        }
      }
      setUserModal(null)
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDeleteUser = async (u: PlatformUserDto) => {
    if (!window.confirm(`Delete user ${u.username}?`)) return
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      await deleteAdminUser(u.id)
      setPageMsg('User deleted.')
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openSystem = async () => {
    setSystemOpen(true)
    setSystemInfo(null)
    try {
      setSystemInfo(await getAdminSystemInfo())
    } catch {
      setSystemInfo(null)
    }
  }

  const onDownloadSupportBundle = async () => {
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      await downloadAdminSupportBundle()
      setPageMsg('Support bundle download started.')
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const httpsStatusBadge = https?.https_listener_active ? (
    <span className="rounded border border-emerald-500/25 bg-emerald-500/[0.08] px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:border-emerald-500/35 dark:bg-emerald-500/12 dark:text-emerald-100/90">
      TLS active
    </span>
  ) : https?.enabled ? (
    <span className="rounded border border-amber-500/25 bg-amber-500/[0.08] px-2 py-0.5 text-[11px] font-semibold text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/85">
      TLS pending
    </span>
  ) : (
    <span className="rounded border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
      HTTP only
    </span>
  )

  const cardShell = gdcUi.cardShell

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Admin settings</h2>
        <p className="max-w-2xl text-[13px] leading-relaxed text-slate-600 dark:text-gdc-muted">
          Operational dashboard for HTTPS, accounts, retention, audit trail, health signals, and alerting configuration.
        </p>
        {canViewGovernance() ? (
          <p className="max-w-2xl text-[12px] text-slate-500 dark:text-gdc-muted">
            Governance operations (violations, quarantine, replay) live on the{' '}
            <Link
              to={NAV_PATH.governance}
              className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
              data-testid="admin-settings-governance-ops-link"
            >
              Governance Dashboard
            </Link>
            . Stream protection and policy are configured in Stream Wizard / Route Processing.
          </p>
        ) : null}
      </div>

      {readOnly ? (
        <div
          role="status"
          className="rounded-lg border border-sky-500/25 bg-sky-500/[0.07] px-3 py-2 text-[13px] text-sky-950 dark:border-sky-500/35 dark:bg-sky-500/10 dark:text-sky-100"
        >
          <strong>Read-only Viewer session.</strong> Mutating actions are disabled in the UI <em>and</em> rejected by the backend
          role guard (HTTP 403). Sign in as <code className="rounded bg-black/5 px-1 dark:bg-white/10">OPERATOR</code> or{' '}
          <code className="rounded bg-black/5 px-1 dark:bg-white/10">ADMINISTRATOR</code> to make changes.
        </div>
      ) : null}
      {isOperator ? (
        <div
          role="status"
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[13px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Operator session — admin/security settings (HTTPS, accounts, retention policy, alert settings) are restricted to
          Administrators.
        </div>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[13px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Could not load admin settings: {loadError}
        </div>
      ) : null}
      {pageErr ? (
        <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-[13px] text-red-900 dark:text-red-100/90">
          {pageErr}
        </div>
      ) : null}
      {pageMsg ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2 text-[13px] text-emerald-950 dark:text-emerald-100/90">
          {pageMsg}
        </div>
      ) : null}

      {/* HTTPS / Security */}
      <section className={cn(cardShell, 'overflow-hidden')} aria-labelledby="admin-https-heading">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Lock className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-https-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                HTTPS / Security
              </h3>
              <p className="mt-0.5 text-[12px] text-slate-600 dark:text-gdc-muted">
                Self-signed TLS via nginx reverse proxy. HTTP stays available if TLS reload fails.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {httpsStatusBadge}
            <span className="rounded border border-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
              {https?.https_listener_active ? 'HTTPS' : https?.enabled ? 'CONFIGURED' : 'HTTP'}
            </span>
          </div>
        </div>

        <div className="grid gap-6 px-4 py-5 md:grid-cols-12 md:px-6 md:py-6">
          <div className="space-y-4 md:col-span-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">HTTPS status</p>
              <div className="mt-1">{httpsStatusBadge}</div>
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="current-access">
                Current access
              </label>
              <input
                id="current-access"
                readOnly
                value={https?.current_access_url ?? '—'}
                className={cn('mt-1 w-full', gdcUi.input, 'opacity-90')}
              />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Runtime</p>
              <ul className="mt-1 space-y-0.5 text-[12px] text-slate-700 dark:text-slate-200">
                <li>HTTP listener: {https?.http_listener_active ? 'active' : 'inactive'}</li>
                <li>HTTPS listener: {https?.https_listener_active ? 'active' : 'inactive'}</li>
                <li>Redirect effective: {https?.redirect_http_to_https_effective ? 'yes' : 'no'}</li>
                <li>Proxy: {https?.proxy_status ?? '—'}</li>
                <li>Proxy health: {https?.proxy_health_ok == null ? 'n/a' : https.proxy_health_ok ? 'ok' : 'failed'}</li>
                <li>Last reload: {formatTs(https?.proxy_last_reload_at ?? null)}</li>
                {https?.proxy_last_reload_detail ? (
                  <li className="break-words text-slate-600 dark:text-gdc-muted">{https.proxy_last_reload_detail}</li>
                ) : null}
                {https?.proxy_fallback_to_http_last ? (
                  <li className="text-amber-800 dark:text-amber-100/90">Recent proxy reload used HTTP fallback.</li>
                ) : null}
              </ul>
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="browser-http">
                Browser HTTP URL
              </label>
              <input
                id="browser-http"
                readOnly
                value={https?.browser_http_url || '—'}
                className={cn('mt-1 w-full', gdcUi.input, 'opacity-90')}
              />
            </div>
            {https?.browser_https_url ? (
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="browser-https">
                  Browser HTTPS URL
                </label>
                <input
                  id="browser-https"
                  readOnly
                  value={https.browser_https_url}
                  className={cn('mt-1 w-full', gdcUi.input, 'opacity-90')}
                />
              </div>
            ) : null}
            {https?.certificate_not_after ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Certificate valid to</p>
                <p className="mt-1 text-[13px] font-medium text-slate-800 dark:text-slate-100">{formatTs(https.certificate_not_after)}</p>
              </div>
            ) : null}
          </div>

          <div className="space-y-4 md:col-span-5">
            {httpsDraft ? (
              <>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2.5 dark:border-gdc-border/80">
                  <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">Enable HTTPS</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-violet-600"
                    checked={httpsDraft.enabled}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, enabled: e.target.checked } : d))}
                  />
                </label>
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="san-ip">
                    Certificate IP addresses (SAN)
                  </label>
                  <input
                    id="san-ip"
                    className={cn('mt-1 w-full', gdcUi.input)}
                    placeholder="e.g. 192.168.1.10, 10.0.0.5"
                    value={httpsDraft.certificate_ip_addresses}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, certificate_ip_addresses: e.target.value } : d))}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="san-dns">
                    Certificate DNS names (SAN) (optional)
                  </label>
                  <input
                    id="san-dns"
                    className={cn('mt-1 w-full', gdcUi.input)}
                    placeholder="e.g. gdc.example.com, gdc.local"
                    value={httpsDraft.certificate_dns_names}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, certificate_dns_names: e.target.value } : d))}
                  />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2.5 dark:border-gdc-border/80">
                  <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">Redirect HTTP to HTTPS</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-violet-600"
                    checked={httpsDraft.redirect_http_to_https}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, redirect_http_to_https: e.target.checked } : d))}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2.5 dark:border-gdc-border/80">
                  <span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">Regenerate self-signed certificate on save</span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-violet-600"
                    checked={httpsDraft.regenerate_certificate}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, regenerate_certificate: e.target.checked } : d))}
                  />
                </label>
                <div>
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="valid-days">
                    Certificate valid days
                  </label>
                  <select
                    id="valid-days"
                    className={cn('mt-1 w-full', gdcUi.select)}
                    value={httpsDraft.certificate_valid_days}
                    onChange={(e) =>
                      setHttpsDraft((d) => (d ? { ...d, certificate_valid_days: Number(e.target.value) } : d))
                    }
                  >
                    {validDaySelectOptions(httpsDraft.certificate_valid_days).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <p className="text-[13px] text-slate-500">Loading…</p>
            )}
          </div>

          <div className="md:col-span-4">
            <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-4 text-[12px] leading-relaxed text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100/90">
              <p className="flex items-center gap-2 font-semibold text-sky-900 dark:text-sky-100">
                <Info className="h-4 w-4 shrink-0" aria-hidden />
                About HTTPS
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>Certificates are self-signed for internal or lab use.</li>
                <li>At least one IP or DNS SAN is required when HTTPS is enabled.</li>
                <li>PEM files are written to configured paths on save; previous files are copied under a backups folder.</li>
                <li>The reverse proxy reloads when GDC_PROXY_RELOAD_URL is configured; otherwise reload nginx manually.</li>
              </ul>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={readOnly || !httpsDirty || busy || !httpsDraft}
                onClick={() => void onSaveHttps()}
                className={cn(
                  'rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors',
                  !readOnly && httpsDirty && !busy
                    ? 'bg-gdc-primary text-white hover:opacity-95'
                    : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-gdc-border dark:text-gdc-muted',
                )}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Admin password */}
      <section className={cn(cardShell, 'p-4 md:p-6')} aria-labelledby="admin-password-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
              <UserRound className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-password-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                Admin password
              </h3>
              <p className="mt-0.5 text-[12px] text-slate-600 dark:text-gdc-muted">Change password for a local platform account.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onChangePassword()}
            disabled={readOnly || busy}
            className="rounded-lg border border-gdc-primary/40 bg-gdc-primary px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-95 disabled:opacity-50"
          >
            Change password
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-12">
          <div className="md:col-span-3">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="pw-user">
              Username
            </label>
            <input
              id="pw-user"
              className={cn('mt-1 w-full', gdcUi.input)}
              value={pwUser}
              onChange={(e) => setPwUser(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="md:col-span-3">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="pw-cur">
              Current password
            </label>
            <div className="relative mt-1">
              <input
                id="pw-cur"
                type={showPw ? 'text' : 'password'}
                className={cn('w-full py-2 pl-3 pr-9', gdcUi.input)}
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw((s) => !s)}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="md:col-span-3">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="pw-new">
              New password
            </label>
            <div className="relative mt-1">
              <input
                id="pw-new"
                type={showPw ? 'text' : 'password'}
                className={cn('w-full py-2 pl-3 pr-9', gdcUi.input)}
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw((s) => !s)}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Minimum 8 characters</p>
          </div>
          <div className="md:col-span-3">
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted" htmlFor="pw-conf">
              Confirm new password
            </label>
            <div className="relative mt-1">
              <input
                id="pw-conf"
                type={showPw ? 'text' : 'password'}
                className={cn('w-full py-2 pl-3 pr-9', gdcUi.input)}
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
                aria-label={showPw ? 'Hide password' : 'Show password'}
                onClick={() => setShowPw((s) => !s)}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Users */}
      <section className={cn(cardShell, 'overflow-hidden')} aria-labelledby="admin-users-heading">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Users className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-users-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                User management
              </h3>
              <p className="mt-0.5 text-[12px] text-slate-600 dark:text-gdc-muted">Local accounts with lightweight roles (not a full RBAC engine).</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                  { label: 'Total users', value: userStats.total },
                  { label: 'Active', value: userStats.active },
                  { label: 'Administrators', value: userStats.admins },
                  { label: 'Operators', value: userStats.operators },
                  { label: 'Viewers', value: userStats.viewers },
                ].map((s) => (
                  <div key={s.label} className={cn('rounded-lg border px-2 py-2', gdcUi.innerWell)}>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{s.label}</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">{s.value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2 text-[11px] leading-snug text-slate-600 dark:border-gdc-border dark:bg-gdc-panel dark:text-gdc-muted">
                Roles are stored for account management. Permission enforcement may be limited until RBAC is fully implemented. Viewer is intended as
                read-only for future operational use (to test locally, set <code className="font-mono text-[10px]">localStorage.gdc_platform_ui_role</code>{' '}
                to <code className="font-mono text-[10px]">VIEWER</code>).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={openCreateUser}
            disabled={readOnly}
            className="rounded-lg border border-gdc-primary/50 px-3 py-1.5 text-[12px] font-semibold text-gdc-primary hover:bg-gdc-primary/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200"
          >
            + New user
          </button>
        </div>

        <div className="overflow-x-auto px-2 py-2 md:px-4">
          <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                <th className="px-2 py-2">Username</th>
                <th className="px-2 py-2">Role</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Created at</th>
                <th className="px-2 py-2">Last login</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const lastOnlyAdmin = u.role === 'ADMINISTRATOR' && u.status === 'ACTIVE' && activeAdminCount <= 1
                const hideActions = u.username.toLowerCase() === 'admin' || lastOnlyAdmin
                return (
                  <tr key={u.id} className="border-b border-slate-50 dark:border-gdc-border/60">
                    <td className="px-2 py-2.5 font-medium text-slate-900 dark:text-slate-50">{u.username}</td>
                    <td className="px-2 py-2.5">
                      <span className={cn('inline-flex rounded border px-2 py-0.5 text-[11px] font-semibold', roleBadgeClass(u.role))}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td className="px-2 py-2.5">
                      <span
                        className={
                          u.status === 'ACTIVE'
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-500 dark:text-gdc-muted'
                        }
                      >
                        {u.status === 'ACTIVE' ? 'Active' : u.status === 'DISABLED' ? 'Disabled' : u.status}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 tabular-nums text-slate-600 dark:text-gdc-mutedStrong">{formatTs(u.created_at)}</td>
                    <td className="px-2 py-2.5 tabular-nums text-slate-600 dark:text-gdc-mutedStrong">{formatTs(u.last_login_at)}</td>
                    <td className="px-2 py-2.5 text-right">
                      {hideActions || readOnly ? (
                        <span className="text-[11px] text-slate-400">{readOnly ? 'Read-only' : '—'}</span>
                      ) : (
                        <span className="inline-flex justify-end gap-1">
                          <button
                            type="button"
                            className="rounded p-1 text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                            aria-label={`Edit ${u.username}`}
                            onClick={() => openEditUser(u)}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="rounded p-1 text-red-600 hover:bg-red-500/10"
                            aria-label={`Delete ${u.username}`}
                            onClick={() => void onDeleteUser(u)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-[12px] text-slate-500 dark:border-gdc-border dark:text-gdc-muted md:px-6">
          Showing {users.length === 0 ? '0' : `1 to ${users.length}`} of {users.length} users
        </div>
      </section>

      {/* System & backup */}
      <section className={cn(cardShell, 'p-4 md:p-6')} aria-labelledby="admin-system-heading">
        <div className="mb-4 flex gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200">
            <Server className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 id="admin-system-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
              System & backup
            </h3>
            <p className="mt-0.5 text-[12px] text-slate-600 dark:text-gdc-muted">Operational utilities. Backup engine behavior is unchanged.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: 'System information',
              desc: 'View system status and environment details.',
              icon: Server,
              onClick: () => void openSystem(),
            },
            {
              title: 'Backup & Import',
              desc: 'Export, import, backup, and restore configuration from one workspace.',
              icon: HardDrive,
              onClick: () => navigate('/operations/backup'),
            },
            {
              title: 'Audit Logs',
              desc: 'Review operator actions: logins, configuration changes, imports, and replays.',
              icon: ClipboardList,
              onClick: () => navigate('/settings/audit-logs'),
            },
          ].map((c) => (
            <button
              key={c.title}
              type="button"
              onClick={c.onClick}
              className="flex w-full items-start gap-3 rounded-xl border border-slate-200/90 bg-slate-50/40 p-4 text-left transition-colors hover:border-violet-300/60 hover:bg-white dark:border-gdc-border dark:bg-gdc-section dark:hover:border-violet-500/30 dark:hover:bg-gdc-cardHover"
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200">
                <c.icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-slate-900 dark:text-slate-50">{c.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-slate-600 dark:text-gdc-muted">{c.desc}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            </button>
          ))}
        </div>
      </section>

      {/* Support bundle */}
      <section className={cn(cardShell, 'p-4 md:p-6')} aria-labelledby="admin-support-bundle-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Package className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-support-bundle-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                Support bundle
              </h3>
              <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                Generates a ZIP of masked JSON summaries for troubleshooting. Does not change runtime, checkpoints, or delivery
                behavior. Only the Administrator role may download.
              </p>
            </div>
          </div>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-[13px] font-semibold transition-colors',
              backendRole === 'ADMINISTRATOR' && !busy
                ? 'border-violet-500/30 bg-violet-600 text-white hover:bg-violet-500 dark:border-violet-500/40 dark:bg-violet-600 dark:hover:bg-violet-500'
                : 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted',
            )}
            disabled={backendRole !== 'ADMINISTRATOR' || busy}
            onClick={() => void onDownloadSupportBundle()}
          >
            <Download className="h-4 w-4 shrink-0" aria-hidden />
            Generate Support Bundle
          </button>
        </div>
        {backendRole !== 'ADMINISTRATOR' ? (
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
            Sign in as <span className="font-medium text-slate-800 dark:text-slate-200">Administrator</span> to download a
            support bundle.
          </p>
        ) : null}
      </section>

      <AdminDisplayTimezoneSettings
        backendRole={backendRole}
        readOnly={readOnly}
        busy={busy}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />

      <AdminNetworkSettingsPage />

      {isDevValidationLabUiEnabled() ? <AdminDevValidationPanel backendRole={backendRole} /> : null}

      <AdminMaintenanceCenter backendRole={backendRole} busy={busy} setBusy={setBusy} />

      <AdminOperationalDashboard
        reloadToken={opReload}
        readOnly={readOnly}
        busy={busy}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />

      {/* System information footer */}
      <section className={cn(cardShell, 'flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6')} aria-label="System information summary">
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-2 text-[12px] text-slate-600 dark:text-gdc-muted">
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Environment</span> {systemFooter?.app_env ?? '—'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Version</span> {systemFooter?.app_version ?? '—'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Uptime</span> {formatUptimeSeconds(systemFooter?.uptime_seconds ?? undefined)}
          </span>
          <span className="max-w-[min(100%,28rem)] truncate" title={systemFooter?.database_version ?? ''}>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Database</span>{' '}
            {systemFooter?.database_reachable === false ? 'unreachable' : systemFooter?.database_version?.split(',')[0]?.trim() ?? 'PostgreSQL'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Timezone</span> {systemFooter?.timezone ?? '—'}
          </span>
          <span className="tabular-nums">
            <span className="font-semibold text-slate-800 dark:text-slate-100">Server (UTC)</span>{' '}
            {systemFooter?.server_time_utc ? formatTs(systemFooter.server_time_utc) : '—'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-card"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </section>

      {userModal ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60" role="dialog" aria-modal="true">
          <div className={cn(gdcUi.modalPanel, 'max-w-md')}>
            <h4 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">{userModal === 'create' ? 'New user' : 'Edit user'}</h4>
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-500">Username</label>
                <input
                  disabled={userModal === 'edit'}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] disabled:bg-slate-100 dark:border-gdc-border dark:disabled:bg-gdc-elevated"
                  value={userForm.username}
                  onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-500">
                  {userModal === 'create' ? 'Password' : 'New password (optional)'}
                </label>
                <input
                  type="password"
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] dark:border-gdc-border"
                  value={userForm.password}
                  onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-500">Role</label>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100 dark:[color-scheme:dark]"
                  value={userForm.role}
                  onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                >
                  <option value="VIEWER">Viewer</option>
                  <option value="OPERATOR">Connector Operator (legacy Operator)</option>
                  <option value="CONNECTOR_OPERATOR">Connector Operator</option>
                  <option value="GOVERNANCE_OPERATOR">Governance Operator</option>
                  <option value="GOVERNANCE_REVIEWER">Governance Reviewer</option>
                  <option value="GOVERNANCE_APPROVER">Governance Approver</option>
                  <option value="GOVERNANCE_AUDITOR">Governance Auditor</option>
                  <option value="ADMINISTRATOR">Administrator</option>
                </select>
              </div>
              {userModal === 'edit' ? (
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-500">Status</label>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100 dark:[color-scheme:dark]"
                    value={userForm.status}
                    onChange={(e) => setUserForm((f) => ({ ...f, status: e.target.value }))}
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="DISABLED">Disabled</option>
                  </select>
                </div>
              ) : null}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-100 dark:hover:bg-gdc-rowHover" onClick={() => setUserModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={readOnly || busy}
                className="rounded-lg bg-gdc-primary px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-95 disabled:opacity-50"
                onClick={() => void onSaveUser()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {systemOpen ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60" role="dialog" aria-modal="true">
          <div className={cn(gdcUi.modalPanel, 'max-w-lg')}>
            <h4 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">System information</h4>
            {systemInfo ? (
              <dl className="mt-4 space-y-2 text-[13px]">
                {Object.entries(systemInfo).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1 dark:border-gdc-border">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="max-w-[60%] break-all text-right font-medium text-slate-900 dark:text-slate-100">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-3 text-[13px] text-slate-500">Loading…</p>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900" onClick={() => setSystemOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
