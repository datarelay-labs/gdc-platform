import {
  createFailoverRoute,
  fetchStreamFailoverRoutes,
  patchFailoverRoute,
  type FailoverRoute,
} from '../../../api/gdcFailoverRouting'
import type { WizardRouteDraft, WizardRouteFailoverDraft } from './wizard-state'

export type FailoverPersistResult = {
  saved: boolean
  routesUpdated: number
  errors: string[]
}

export function failoverDraftFromRoute(route: FailoverRoute): WizardRouteFailoverDraft {
  return {
    id: route.id,
    enabled: route.enabled === true,
    secondaryDestinationId: route.secondary_destination_id,
  }
}

export function applyFailoverRoutesToWizardDrafts(
  drafts: WizardRouteDraft[],
  routes: readonly FailoverRoute[],
): WizardRouteDraft[] {
  if (routes.length === 0) return drafts
  const byPrimary = new Map<number, FailoverRoute>()
  for (const route of routes) {
    if (!byPrimary.has(route.primary_destination_id)) {
      byPrimary.set(route.primary_destination_id, route)
    }
  }
  return drafts.map((draft) => {
    const rule = byPrimary.get(draft.destinationId)
    if (!rule) return draft
    return { ...draft, failover: failoverDraftFromRoute(rule) }
  })
}

export async function loadWizardFailover(
  streamId: number,
  drafts: WizardRouteDraft[],
): Promise<WizardRouteDraft[]> {
  const payload = await fetchStreamFailoverRoutes(streamId)
  return applyFailoverRoutesToWizardDrafts(drafts, payload?.routes ?? [])
}

function uniquePrimaryDrafts(drafts: readonly WizardRouteDraft[]): WizardRouteDraft[] {
  const seen = new Set<number>()
  const out: WizardRouteDraft[] = []
  for (const draft of drafts) {
    const primaryId = Number(draft.destinationId)
    if (!Number.isFinite(primaryId) || primaryId <= 0 || seen.has(primaryId)) continue
    seen.add(primaryId)
    out.push(draft)
  }
  return out
}

export async function persistWizardFailover(
  streamId: number,
  drafts: readonly WizardRouteDraft[],
): Promise<FailoverPersistResult> {
  const errors: string[] = []
  let routesUpdated = 0
  let existing: FailoverRoute[] = []
  try {
    const payload = await fetchStreamFailoverRoutes(streamId)
    existing = payload?.routes ?? []
  } catch (err) {
    return {
      saved: false,
      routesUpdated: 0,
      errors: [`failover-routes list: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  const existingByPrimary = new Map<number, FailoverRoute>()
  const existingById = new Map<number, FailoverRoute>()
  for (const route of existing) {
    existingById.set(route.id, route)
    if (!existingByPrimary.has(route.primary_destination_id)) {
      existingByPrimary.set(route.primary_destination_id, route)
    }
  }

  for (const draft of uniquePrimaryDrafts(drafts)) {
    const primaryId = Number(draft.destinationId)
    const failover = draft.failover
    const current =
      (failover?.id != null ? existingById.get(failover.id) : undefined) ?? existingByPrimary.get(primaryId)

    if (!failover?.enabled) {
      if (!current) continue
      if (!current.enabled) continue
      try {
        await patchFailoverRoute(streamId, current.id, { enabled: false })
        routesUpdated += 1
      } catch (err) {
        errors.push(
          `failover disable primary ${primaryId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      continue
    }

    const secondaryId = Number(failover.secondaryDestinationId)
    if (!Number.isFinite(secondaryId) || secondaryId <= 0) {
      errors.push(`failover enabled for destination ${primaryId} requires a standby destination`)
      continue
    }
    if (secondaryId === primaryId) {
      errors.push(`failover primary and standby destinations must differ (destination ${primaryId})`)
      continue
    }

    try {
      if (current) {
        await patchFailoverRoute(streamId, current.id, {
          primary_destination_id: primaryId,
          secondary_destination_id: secondaryId,
          enabled: true,
        })
      } else {
        await createFailoverRoute(streamId, {
          primary_destination_id: primaryId,
          secondary_destination_id: secondaryId,
          enabled: true,
        })
      }
      routesUpdated += 1
    } catch (err) {
      errors.push(`failover destination ${primaryId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { saved: errors.length === 0, routesUpdated, errors }
}
