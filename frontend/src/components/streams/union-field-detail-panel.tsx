import {
  formatUnionOccurrence,
  isRareUnionField,
  type UnionSchema,
  type UnionSchemaField,
} from '../../utils/unionSchema'
import { isUnionFieldSensitive } from '../../utils/unionSchemaFieldDisplay'
import { suggestUnionFieldTypeLabel } from '../../utils/unionFieldSuggestedType'

export type UnionFieldDetailPanelProps = {
  field: UnionSchemaField | null
  schema: UnionSchema
}

export function UnionFieldDetailPanel({ field, schema }: UnionFieldDetailPanelProps) {
  if (!field) {
    return (
      <div
        className="flex min-h-[120px] items-center justify-center rounded-md border border-dashed border-slate-200/80 bg-slate-50/40 px-3 py-4 text-center dark:border-gdc-border dark:bg-gdc-section/40"
        data-testid="union-field-detail-panel"
      >
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Select a field to view details</p>
      </div>
    )
  }

  const rare = isRareUnionField(field, schema)
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
          <dd className="mt-0.5 text-slate-800 dark:text-slate-100">{field.field_type}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Frequency</dt>
          <dd className="mt-0.5 tabular-nums text-slate-800 dark:text-slate-100" data-testid="union-field-detail-frequency">
            {formatUnionOccurrence(field, schema)}
          </dd>
        </div>
        {(rare || sensitive) && (
          <div>
            <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Flags</dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {rare ? (
                <span
                  className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-800 dark:text-amber-200"
                  data-testid="union-field-detail-rare"
                >
                  rare
                </span>
              ) : null}
              {sensitive ? (
                <span
                  className="rounded bg-violet-500/15 px-1 text-[9px] font-bold text-violet-800 dark:text-violet-200"
                  data-testid="union-field-detail-sensitive"
                >
                  sensitive
                </span>
              ) : null}
            </dd>
          </div>
        )}
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
                  <li key={`${field.field_path}-sample-${idx}`} className="truncate font-mono text-[10px] text-slate-600 dark:text-gdc-muted">
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
