import { useEffect, useState, type FormEvent } from 'react'
import {
  BookOpen,
  ExternalLink,
  Globe,
  Lock,
  Mail,
  Rocket,
  ScrollText,
  User,
  Eye,
  EyeOff,
} from 'lucide-react'
import { postAuthLogin } from '../../api/gdcAdmin'
import { userFacingLoginError } from '../../auth/login-error'
import { accessTokenRequiresPasswordChange } from '../../auth/jwt-session-hints'
import { markSessionRequiresPasswordChange } from '../../auth/password-change-gate'
import { persistSession } from '../../auth/session'
import { cn } from '../../lib/utils'
import { DataRelayLogoMark, DataRelayWordmark } from './datarelay-logo'

const RESOURCES: readonly {
  title: string
  subtitle: string
  href: string
  icon: typeof BookOpen
}[] = [
  {
    title: 'Documentation',
    subtitle: 'datarelay.run/docs',
    href: 'https://datarelay.run/docs',
    icon: BookOpen,
  },
  {
    title: 'Quick Start Guide',
    subtitle: 'datarelay.run/quickstart',
    href: 'https://datarelay.run/quickstart',
    icon: Rocket,
  },
  {
    title: 'Release Notes',
    subtitle: 'datarelay.run/releases',
    href: 'https://datarelay.run/releases',
    icon: ScrollText,
  },
  {
    title: 'DataRelay Website',
    subtitle: 'datarelay.run',
    href: 'https://datarelay.run',
    icon: Globe,
  },
  {
    title: 'Support',
    subtitle: 'support@datarelay.run',
    href: 'mailto:support@datarelay.run',
    icon: Mail,
  },
]

type PlatformLoginPageProps = {
  onAuthenticated: () => void
}

export function PlatformLoginPage({ onAuthenticated }: PlatformLoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    try {
      if (sessionStorage.getItem('gdc_post_password_change') === '1') {
        sessionStorage.removeItem('gdc_post_password_change')
        setInfo('Password updated. Sign in with your new password.')
      }
    } catch {
      /* ignore */
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const u = username.trim()
    if (!u || !password) {
      setError('Enter your username and password.')
      return
    }
    setBusy(true)
    try {
      const res = await postAuthLogin({ username: u, password })
      persistSession({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
        expires_at: res.expires_at,
      user: {
        username: res.user.username,
        role: res.user.role,
        status: res.user.status,
        ...(res.user.must_change_password === true ? { must_change_password: true } : {}),
        ...(res.user.capabilities ? { capabilities: res.user.capabilities } : {}),
      },
      })
      if (res.user.must_change_password === true || accessTokenRequiresPasswordChange(res.access_token)) {
        markSessionRequiresPasswordChange()
      }
      onAuthenticated()
    } catch (err) {
      console.error('[gdc] login failed', err)
      setError(userFacingLoginError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="relative flex min-h-screen flex-col bg-[#020617] text-slate-200"
      style={{
        backgroundImage:
          'radial-gradient(ellipse 80% 60% at 50% 20%, rgba(30, 58, 138, 0.35), transparent 55%), radial-gradient(ellipse 70% 50% at 50% 100%, rgba(6, 78, 59, 0.12), transparent 50%)',
      }}
    >
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6 lg:px-10">
        <div className="grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-center lg:gap-14">
          {/* Left — identity & resources */}
          <div className="flex flex-col gap-6 lg:max-w-md">
            <header className="space-y-4">
              <div className="flex items-start gap-3">
                <DataRelayLogoMark className="h-10 w-14 sm:h-11 sm:w-[3.9rem]" aria-label="DataRelay logo" />
              </div>
              <DataRelayWordmark />
              <p className="text-sm font-medium text-slate-400">Operational Data Connector Platform</p>
              <p className="text-base font-semibold leading-relaxed">
                <span className="text-sky-400">Collect.</span>{' '}
                <span className="text-emerald-400">Transform.</span>{' '}
                <span className="text-sky-400">Deliver.</span>
              </p>
              <p className="text-sm leading-relaxed text-slate-400">
                Connect to any source, transform and enrich your data, then deliver it to multiple destinations reliably and
                securely.
              </p>
            </header>

            <section aria-labelledby="login-resources-heading" className="space-y-3">
              <h2 id="login-resources-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Resources
              </h2>
              <ul className="space-y-1">
                {RESOURCES.map((item) => {
                  const Icon = item.icon
                  const isHttp = item.href.startsWith('http')
                  return (
                    <li key={item.title}>
                      <a
                        href={item.href}
                        className="group flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-sky-500/20 hover:bg-white/[0.03]"
                        {...(isHttp ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-400">
                          <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-white">{item.title}</span>
                          <span className="block truncate text-xs text-sky-400/90">{item.subtitle}</span>
                        </span>
                        {isHttp ? (
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-sky-500/80 opacity-70 group-hover:opacity-100" aria-hidden />
                        ) : null}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>

          {/* Right — sign-in card */}
          <div
            className={cn(
              'w-full max-w-md justify-self-center rounded-2xl border border-white/10 bg-slate-950/55 p-6 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.75)] backdrop-blur-md sm:p-8',
              'lg:justify-self-end',
            )}
          >
            <div className="mb-6 flex flex-col items-center text-center">
              <div
                className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-slate-900/80"
                style={{
                  background: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(52,211,153,0.18))',
                }}
                aria-hidden
              >
                <Lock className="h-6 w-6 text-sky-300 drop-shadow-[0_0_10px_rgba(52,211,153,0.35)]" strokeWidth={2} />
              </div>
              <h1 className="text-xl font-semibold text-white sm:text-2xl">Welcome to DataRelay</h1>
              <p className="mt-1 text-sm text-slate-400">Please sign in to continue.</p>
            </div>

            <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
              <div>
                <label htmlFor="platform-login-username" className="mb-1.5 block text-xs font-medium text-slate-400">
                  Username
                </label>
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden
                  />
                  <input
                    id="platform-login-username"
                    name="username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    className="h-11 w-full rounded-lg border border-white/12 bg-slate-950/60 py-2 pl-10 pr-3 text-sm text-white placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none focus:ring-2 focus:ring-sky-500/25"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="platform-login-password" className="mb-1.5 block text-xs font-medium text-slate-400">
                  Password
                </label>
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden
                  />
                  <input
                    id="platform-login-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="h-11 w-full rounded-lg border border-white/12 bg-slate-950/60 py-2 pl-10 pr-11 text-sm text-white placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none focus:ring-2 focus:ring-sky-500/25"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {info ? (
                <p className="rounded-md border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-100" role="status">
                  {info}
                </p>
              ) : null}

              {error ? (
                <p className="rounded-md border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-xs text-rose-200" role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={busy}
                className="mt-2 flex h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-sky-500 to-emerald-500 text-sm font-semibold text-white shadow-lg shadow-sky-900/30 transition-opacity hover:opacity-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign In'}
              </button>

              <p className="pt-1 text-center text-[11px] leading-relaxed text-slate-500">
                Accounts are created by an administrator. Self-service registration is not available.
              </p>
            </form>
          </div>
        </div>
      </div>

      <footer className="border-t border-white/[0.06] px-4 py-5 text-center text-[11px] text-slate-500 sm:text-xs">
        <p className="mb-2">© 2026 DataRelay. All rights reserved.</p>
        <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <a href="https://datarelay.run/privacy" className="text-sky-400/90 hover:underline" rel="noopener noreferrer" target="_blank">
            Privacy Policy
          </a>
          <span className="text-slate-600" aria-hidden>
            |
          </span>
          <a href="https://datarelay.run/terms" className="text-sky-400/90 hover:underline" rel="noopener noreferrer" target="_blank">
            Terms of Use
          </a>
          <span className="text-slate-600" aria-hidden>
            |
          </span>
          <a
            href="https://datarelay.run/security"
            className="text-sky-400/90 hover:underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Security
          </a>
        </p>
      </footer>
    </div>
  )
}
