import { isUnionFieldSensitive } from '../../../utils/unionSchemaFieldDisplay'
import type { UnionSchema } from '../../../utils/unionSchema'
import type { WizardSensitivityClass, WizardState } from './wizard-state'
import { collectWizardProtectionFieldCandidatesSync } from './wizard-data-protection-path-resolve'

function leafSegment(fieldPath: string): string {
  const trimmed = fieldPath.trim()
  const leaf = trimmed.split('.').pop() ?? trimmed
  return leaf.replace(/\[\d+\]/g, '').replace(/^\$\.?/, '').toLowerCase()
}

function normalizeSensitivityClass(value: string | null | undefined): WizardSensitivityClass | null {
  if (value === 'secret' || value === 'pii' || value === 'security_metadata') return value
  return null
}

function classFromUnionField(
  field: { sensitivity_class?: string | null } | undefined,
): WizardSensitivityClass | null | undefined {
  if (!field) return undefined
  const mapped = normalizeSensitivityClass(field.sensitivity_class)
  if (mapped) return mapped
  // attachSensitiveSuggestions writes null when the backend evaluated the field as not sensitive.
  if (field.sensitivity_class === null) return null
  return undefined
}

/**
 * Backend Union Schema `sensitivity_class` is the source of truth.
 * Returns null when backend already evaluated the field as not sensitive.
 * Legacy `pii` fallback applies only when no backend result exists for the path.
 */
export function inferWizardSensitivityClass(
  fieldPath: string,
  unionSchema?: UnionSchema | null,
): WizardSensitivityClass | null {
  const fields = unionSchema?.fields ?? []
  const exact = classFromUnionField(fields.find((field) => field.field_path === fieldPath))
  if (exact !== undefined) return exact
  const leaf = leafSegment(fieldPath)
  const byLeaf = classFromUnionField(
    fields.find((field) => leafSegment(field.field_path) === leaf),
  )
  if (byLeaf !== undefined) return byLeaf
  return 'pii'
}

export function normalizeWizardDetectedField(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('$')) return trimmed
  return `$.${trimmed}`
}

/** Candidate detected fields from the runtime enriched event preview (mapping + enrichment). */
export function collectWizardDetectedFieldCandidates(state: WizardState): string[] {
  return collectWizardProtectionFieldCandidatesSync(state)
}

export function suggestLikelySensitiveFieldsFromState(state: WizardState): string[] {
  const suggestedFields = (state.apiTest.unionSchema?.fields ?? []).filter(isUnionFieldSensitive)
  if (suggestedFields.length === 0) return []
  const suggestedLeaves = new Set(suggestedFields.map((field) => leafSegment(field.field_path)))
  const suggestedPaths = new Set(suggestedFields.map((field) => field.field_path))
  return collectWizardDetectedFieldCandidates(state).filter((path) => {
    return suggestedPaths.has(path) || suggestedLeaves.has(leafSegment(path))
  })
}

export function sensitivityClassLabel(sensitivityClass: WizardSensitivityClass): string {
  switch (sensitivityClass) {
    case 'secret':
      return 'Secret'
    case 'security_metadata':
      return 'Security metadata'
    default:
      return 'Personal data'
  }
}
