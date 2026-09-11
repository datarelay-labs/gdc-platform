import { CheckCircle2, ExternalLink, Scale, ShieldCheck, Tags, Wand2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { NAV_PATH } from '../../../config/nav-paths'

type StreamSharedCard = {
  key: string
  title: string
  description: string
  icon: typeof Wand2
}

const STREAM_SHARED_CARDS: StreamSharedCard[] = [
  {
    key: 'transform',
    title: 'Transform',
    description: 'Mapping, transform rules, field operations.',
    icon: Wand2,
  },
  {
    key: 'data_protection',
    title: 'Data Protection',
    description: 'Schema drift policy and field protection rules.',
    icon: ShieldCheck,
  },
  {
    key: 'classification',
    title: 'Classification',
    description: 'Shared default level inherited by every route.',
    icon: Tags,
  },
  {
    key: 'policy',
    title: 'Policy',
    description: 'Shared delivery policy inherited by every route.',
    icon: Scale,
  },
]

/** @deprecated Use StreamSharedProcessingSection */
export const StreamGlobalProcessingSection = StreamSharedProcessingSection

export function StreamSharedProcessingSection({
  streamId,
  routeCount = 0,
}: {
  streamId: number
  routeCount?: number
}) {
  return (
    <section className="space-y-3" data-testid="stream-shared-processing-section">
      <article className="rounded-lg border border-slate-200/90 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Shared Processing</h4>
            <span className="rounded-full border border-violet-300/70 bg-violet-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-800 dark:border-violet-500/40 dark:text-violet-200">
              Baseline
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
            Applied to all routes — Transform, Data Protection, Classification, and Policy are inherited unless
            overridden per destination. Delivery stays route-specific.
          </p>
          {routeCount > 0 ? (
            <p className="mt-1 text-[10px] font-semibold text-violet-700 dark:text-violet-300" data-testid="stream-shared-processing-route-count">
              Applied to {routeCount} Route{routeCount === 1 ? '' : 's'}
            </p>
          ) : null}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {STREAM_SHARED_CARDS.map((card) => {
            const Icon = card.icon
            return (
              <article
                key={card.key}
                className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-2.5 dark:border-gdc-border dark:bg-gdc-section/40"
                data-testid={`stream-shared-processing-card-${card.key}`}
              >
                <div className="flex items-start gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300">
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{card.title}</p>
                    <p className="mt-0.5 text-[9px] leading-snug text-slate-500 dark:text-gdc-muted">{card.description}</p>
                  </div>
                </div>
                <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                  Configured
                </p>
                <Link
                  to={`${NAV_PATH.streams}/${streamId}#governance`}
                  className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                >
                  Edit in Governance
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              </article>
            )
          })}
        </div>
      </article>
    </section>
  )
}
