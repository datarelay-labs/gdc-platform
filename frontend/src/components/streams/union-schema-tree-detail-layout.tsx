import { useMemo } from 'react'
import type { WizardEnrichmentRule } from './wizard/enrichment-rules-model'
import { cn } from '../../lib/utils'
import {
  generatedFieldPathMap,
  generatedFieldRuleTypeLabel,
  ruleToSyntheticUnionField,
} from '../../utils/generatedFieldsTree'
import { suggestUnionFieldTypeLabel } from '../../utils/unionFieldSuggestedType'
import { isUnionFieldSensitive } from '../../utils/unionSchemaFieldDisplay'
import { unionSchemaFieldMap, type UnionSchemaField } from '../../utils/unionSchema'
import { UnionFieldDetailPanel } from './union-field-detail-panel'
import { UnionSchemaTree, type UnionSchemaTreeProps } from './union-schema-tree'

export type UnionSchemaTreeDetailLayoutProps = UnionSchemaTreeProps & {
  selectedPath: string | null
  onSelectPath: (path: string) => void
  className?: string
  generatedRules?: readonly WizardEnrichmentRule[]
}

function GeneratedUnionFieldDetailPanel({
  field,
  rule,
}: {
  field: UnionSchemaField
  rule: WizardEnrichmentRule
}) {
  const sensitive = isUnionFieldSensitive(field)
  const suggestedType = suggestUnionFieldTypeLabel(field)
  const samples = field.sample_values.slice(0, 5)

  return (
    <div
      className="space-y-2 rounded-md border border-slate-200/70 bg-white/80 p-2.5 dark:border-gdc-border dark:bg-gdc-card/80"
      data-testid="union-field-detail-panel"
    >
      <dl className="space-y-2 text-[11px]">
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Field</dt>
          <dd className="mt-0.5 break-all font-mono font-semibold text-slate-800 dark:text-slate-100">
            {field.field_path}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Type</dt>
          <dd className="mt-0.5 text-slate-800 dark:text-slate-100" data-testid="generated-field-detail-type">
            {generatedFieldRuleTypeLabel(rule.type)}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Frequency</dt>
          <dd
            className="mt-0.5 text-slate-800 dark:text-slate-100"
            data-testid="union-field-detail-frequency"
          >
            generated
          </dd>
        </div>
        {sensitive ? (
          <div>
            <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Flags</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              <span
                className="rounded bg-violet-500/15 px-1 text-[9px] font-bold text-violet-800 dark:text-violet-200"
                data-testid="union-field-detail-sensitive"
              >
                sensitive
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Suggested Type</dt>
          <dd className="mt-0.5 text-slate-800 dark:text-slate-100" data-testid="union-field-detail-suggested-type">
            {suggestedType}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Sample Values</dt>
          <dd className="mt-1">
            {samples.length === 0 ? (
              <p className="text-slate-500 dark:text-gdc-muted">—</p>
            ) : (
              <ul className="list-none space-y-0.5" data-testid="union-field-detail-samples">
                {samples.map((sample, idx) => (
                  <li
                    key={`${field.field_path}-sample-${idx}`}
                    className="truncate font-mono text-[10px] text-slate-600 dark:text-gdc-muted"
                  >
                    {JSON.stringify(sample)}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function UnionSchemaTreeDetailLayout({
  schema,
  selectedPath,
  onSelectPath,
  className,
  generatedRules = [],
  ...treeProps
}: UnionSchemaTreeDetailLayoutProps) {
  const generatedByPath = useMemo(() => generatedFieldPathMap(generatedRules), [generatedRules])

  const selectedGeneratedRule = useMemo(() => {
    if (!selectedPath) return null
    return generatedByPath.get(selectedPath) ?? null
  }, [generatedByPath, selectedPath])

  const selectedField = useMemo(() => {
    if (!selectedPath) return null
    if (selectedGeneratedRule) return ruleToSyntheticUnionField(selectedGeneratedRule)
    return unionSchemaFieldMap(schema).get(selectedPath) ?? null
  }, [schema, selectedGeneratedRule, selectedPath])

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col gap-2 xl:flex-row xl:gap-0', className)}
      data-testid="union-schema-tree-detail-layout"
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto xl:pr-2">
        <UnionSchemaTree
          {...treeProps}
          schema={schema}
          selectedPath={selectedPath}
          onSelectPath={onSelectPath}
          generatedRules={generatedRules}
        />
      </div>
      <div className="shrink-0 border-t border-slate-200/70 pt-2 dark:border-gdc-border xl:w-[38%] xl:min-w-[140px] xl:max-w-[220px] xl:border-l xl:border-t-0 xl:pl-2 xl:pt-0">
        {selectedGeneratedRule && selectedField ? (
          <GeneratedUnionFieldDetailPanel field={selectedField} rule={selectedGeneratedRule} />
        ) : (
          <UnionFieldDetailPanel field={selectedField} schema={schema} />
        )}
      </div>
    </div>
  )
}
