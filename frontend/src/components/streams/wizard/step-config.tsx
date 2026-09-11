import { Plus, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IncrementalFetchCompatibilityHints } from '../incremental-fetch-compatibility-hints'
import { cn } from '../../../lib/utils'
import { wizardIncrementalFetchGuidanceComplete } from './wizard-step-gates'
import type { StreamConfigHeaderRow, StreamConfigParamRow, WizardConfigState, WizardState } from './wizard-state'
import { buildFullRequestUrl, effectiveRequestHeaders } from './wizard-state'
import {
  BODY_TEMPLATES,
  BODY_TEMPLATE_VARIABLES,
  DEFAULT_BODY_TEMPLATE_ID,
  type BodyTemplateId,
} from './wizard-body-templates'
import { StreamConfigAdvancedPanels } from '../stream-config-advanced-panels'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400/30 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

type StepConfigSection = 'request' | 'advanced'

type StepConfigProps = {
  state: WizardState
  section?: StepConfigSection
  onChange: (patch: Partial<WizardState['stream']>) => void
}

function newRowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
}

export function StepConfig({ state, section = 'request', onChange }: StepConfigProps) {
  const c = state.stream
  const connector = state.connector
  const isS3 = connector.sourceType === 'S3_OBJECT_POLLING'
  const isRemote = connector.sourceType === 'REMOTE_FILE_POLLING'
  const isDb = connector.sourceType === 'DATABASE_QUERY'
  const isWebhook = connector.sourceType === 'WEBHOOK_RECEIVER'
  const fullUrl = buildFullRequestUrl(connector.hostBaseUrl, c.endpoint)
  const mergedHeaders = effectiveRequestHeaders(connector, c)
  const inheritedRows = connector.commonHeaders.filter((r) => r.key.trim())
  const additionalHeaderRows = c.headers.filter((r) => r.key.trim())
  const sessionLogin = connector.authType === 'SESSION_LOGIN'
  const incrementalGuidanceComplete = wizardIncrementalFetchGuidanceComplete(state)

  const [selectedBodyTemplate, setSelectedBodyTemplate] = useState<BodyTemplateId>(DEFAULT_BODY_TEMPLATE_ID)

  function patchHeaders(rows: StreamConfigHeaderRow[]) {
    onChange({ headers: rows })
  }

  function patchParams(rows: StreamConfigParamRow[]) {
    onChange({ params: rows })
  }

  function applyBodyTemplate(nextId: BodyTemplateId) {
    const template = BODY_TEMPLATES.find((t) => t.id === nextId)
    if (!template) return
    setSelectedBodyTemplate(nextId)
    onChange({ requestBody: template.body })
  }

  const urlPlaceholder =
    connector.connectorId == null
      ? 'Select a connector first'
      : !connector.hostBaseUrl.trim()
        ? isRemote
          ? 'Connector has no SSH host'
          : 'Connector has no base URL'
        : ''

  return (
    <section
      className="rounded-md border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid={section === 'request' ? 'wizard-connect-request' : 'wizard-connect-advanced'}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          {section === 'request' ? 'Request Configuration' : 'Advanced Settings'}
        </h3>
        {isRemote && section === 'request' ? (
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">REMOTE_FILE_POLLING stream</p>
        ) : null}
      </div>

      {section === 'request' ? (
        <>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <Field label="Stream name *">
          <input
            value={c.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Cybereason Malop Stream"
            className={inputCls}
          />
        </Field>
        {isS3 ? (
          <Field label="Max objects per run *">
            <input
              type="number"
              min={1}
              value={c.maxObjectsPerRun}
              onChange={(e) => onChange({ maxObjectsPerRun: Math.max(1, Number(e.target.value || 1)) })}
              className={inputCls}
            />
          </Field>
        ) : isDb ? (
          <div className="md:col-span-2">
            <label
              htmlFor="wizard-database-sql-query"
              className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong"
            >
              SQL Query *
            </label>
            <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-muted">
              SELECT-only query against the saved database connection. Sample rows use the existing preview limit; credentials stay on the connector.
            </p>
            <textarea
              id="wizard-database-sql-query"
              data-testid="wizard-database-sql-query"
              value={c.sqlQuery}
              onChange={(e) => onChange({ sqlQuery: e.target.value })}
              rows={8}
              aria-label="SQL Query"
              placeholder="SELECT id, email, created_at FROM users"
              className="mt-1 w-full rounded-md border border-slate-200/90 bg-white px-2 py-1.5 font-mono text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            />
          </div>
        ) : isRemote ? (
          <>
            <Field label="Remote directory *">
              <input
                value={c.remoteDirectory}
                onChange={(e) => onChange({ remoteDirectory: e.target.value })}
                placeholder="/data/security"
                className={`${inputCls} font-mono text-[11px]`}
              />
            </Field>
            <Field label="File pattern *">
              <input
                value={c.filePattern}
                onChange={(e) => onChange({ filePattern: e.target.value })}
                placeholder="*.ndjson"
                className={`${inputCls} font-mono text-[11px]`}
              />
            </Field>
            <Field label="Parser type">
              <select
                value={c.parserType}
                onChange={(e) => onChange({ parserType: e.target.value })}
                className={inputCls}
              >
                <option value="NDJSON">NDJSON</option>
                <option value="JSON_ARRAY">JSON_ARRAY</option>
                <option value="JSON_OBJECT">JSON_OBJECT</option>
                <option value="CSV">CSV</option>
                <option value="LINE_DELIMITED_TEXT">LINE_DELIMITED_TEXT</option>
              </select>
            </Field>
          </>
        ) : isWebhook ? (
          <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-card md:col-span-2">
            <p className="font-semibold text-slate-700 dark:text-slate-200">Webhook receiver stream</p>
            <p className="mt-1 text-slate-600 dark:text-gdc-muted">
              Push ingestion uses the connector receiver URL. Configure event extraction in the preview and mapping steps.
            </p>
          </div>
        ) : (
          <>
            <Field label="HTTP method">
              <select
                value={c.httpMethod}
                onChange={(e) => onChange({ httpMethod: e.target.value as WizardConfigState['httpMethod'] })}
                className={inputCls}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </Field>
            <Field label="Endpoint path *">
              <input value={c.endpoint} onChange={(e) => onChange({ endpoint: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Full Request URL Preview">
              <input
                readOnly
                tabIndex={-1}
                value={fullUrl}
                placeholder={urlPlaceholder}
                aria-readonly="true"
                className={`${inputCls} cursor-default bg-slate-50 text-slate-700 dark:bg-gdc-section dark:text-slate-200`}
              />
            </Field>
          </>
        )}
      </div>

      {!isS3 && !isRemote && !isDb && !isWebhook ? (
        <>
          <div className="mt-3 rounded-md border border-slate-200/80 bg-slate-50/70 p-2 dark:border-gdc-border dark:bg-gdc-card">
            <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">Inherited Connector Headers</p>
        {inheritedRows.length === 0 ? (
          <p className="mt-1 text-[11px] italic text-slate-500 dark:text-gdc-muted">None configured on the connector.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {inheritedRows.map((row) => (
              <li key={row.id} className="grid grid-cols-[1fr_1.4fr] gap-2 text-[11px]">
                <span className="rounded border border-slate-200/90 bg-white px-2 py-1 font-mono text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200">
                  {row.key}
                </span>
                <span className="rounded border border-slate-200/90 bg-white px-2 py-1 font-mono text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200">
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <KeyValueEditor
          title="Additional Stream Headers"
          rows={c.headers}
          onChange={patchHeaders}
          newRow={() => ({ id: newRowId('h'), key: '', value: '' })}
          placeholderKey="X-Request-ID"
          placeholderValue="optional override"
        />
        <KeyValueEditor
          title="Query parameters"
          rows={c.params}
          onChange={patchParams}
          newRow={() => ({ id: newRowId('p'), key: '', value: '' })}
          placeholderKey="param"
          placeholderValue="value"
        />
      </div>
      <div className="mt-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label
            htmlFor="wizard-json-request-body"
            className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong"
          >
            JSON Request Body (optional)
          </label>
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="wizard-body-template"
              className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong"
            >
              Body template
            </label>
            <select
              id="wizard-body-template"
              aria-label="Body template"
              value={selectedBodyTemplate}
              onChange={(e) => applyBodyTemplate(e.target.value as BodyTemplateId)}
              className="h-7 rounded-md border border-slate-200/90 bg-white px-1.5 text-[11px] text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400/30 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:[color-scheme:dark]"
            >
              {BODY_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-muted">
          Request body is optional. Most REST APIs work without it. Use a template only when the API requires a search body, timestamp window, or pagination cursor.
        </p>
        <textarea
          id="wizard-json-request-body"
          value={c.requestBody}
          onChange={(e) => onChange({ requestBody: e.target.value })}
          rows={5}
          aria-label="JSON Request Body"
          placeholder='{"filters":[{"fieldName":"creationTime","operator":"GreaterThan","values":["{{checkpoint.last_timestamp}}"]}]}'
          className="mt-1 w-full rounded-md border border-slate-200/90 bg-white px-2 py-1.5 font-mono text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">
          <span className="font-semibold uppercase tracking-wide">Variables:</span>
          {BODY_TEMPLATE_VARIABLES.map((v) => (
            <code
              key={v}
              className="rounded border border-slate-200/90 bg-slate-50 px-1 py-0.5 font-mono text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
            >
              {v}
            </code>
          ))}
        </div>
        <IncrementalFetchCompatibilityHints
          requestBodyText={c.requestBody}
          queryParams={Object.fromEntries(
            c.params.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
          )}
          guidanceComplete={incrementalGuidanceComplete}
          className="mt-1.5"
        />
      </div>
      <div className="mt-3 rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
        <p className="font-semibold text-slate-700 dark:text-slate-200">Request Summary</p>
        <p className="mt-1 break-all font-mono text-[11px] text-slate-800 dark:text-slate-100">
          {c.httpMethod} {fullUrl || '(select connector / base URL)'}
        </p>
        <ul className="mt-1 grid gap-x-3 gap-y-0.5 text-[10px] text-slate-600 dark:text-gdc-mutedStrong sm:grid-cols-2">
          <li>Inherited connector headers: {inheritedRows.length}</li>
          <li>Additional stream headers: {additionalHeaderRows.length}</li>
          <li>Effective headers: {Object.keys(mergedHeaders).length}</li>
          <li>Body: {c.requestBody.trim() ? 'configured' : 'none'}</li>
          <li>Auth: {connector.authType}</li>
          <li>Session login: {sessionLogin ? 'yes' : 'no'}</li>
          <li>Query parameters: {c.params.filter((r) => r.key.trim()).length}</li>
        </ul>
      </div>
        </>
      ) : isS3 ? (
        <p className="mt-3 text-[11px] text-slate-600 dark:text-gdc-muted">
          S3 object polling uses the connector Source configuration. No HTTP request body is sent for this stream type.
        </p>
      ) : isDb ? (
        <div className="mt-3 rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
          <p className="font-semibold text-slate-700 dark:text-slate-200">Database query summary</p>
          <p className="mt-1 font-mono text-[11px] text-slate-800 dark:text-slate-100">
            {c.sqlQuery.trim() || '(set SQL query)'} · timeout {c.timeoutSec}s
          </p>
        </div>
      ) : isRemote ? (
        <div className="mt-3 rounded-md border border-slate-200/80 bg-slate-50/70 px-2.5 py-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
          <p className="font-semibold text-slate-700 dark:text-slate-200">Remote file summary</p>
          <p className="mt-1 font-mono text-[11px] text-slate-800 dark:text-slate-100">
            {c.remoteDirectory.trim() || '(set remote directory)'} · {c.filePattern || '*'} · {c.parserType}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-slate-600 dark:text-gdc-muted">
          Webhook receiver: runtime ingestion starts when producers POST to the generated receiver URL.
        </p>
      )}
        </>
      ) : (
        <>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <Field label="Polling interval (sec)">
              <input
                type="number"
                min={5}
                value={c.pollingIntervalSec}
                onChange={(e) => onChange({ pollingIntervalSec: Math.max(5, Number(e.target.value || 5)) })}
                className={inputCls}
              />
            </Field>
            <Field label={isDb ? 'Query timeout (sec)' : 'Timeout (sec)'}>
              <input
                type="number"
                min={1}
                value={c.timeoutSec}
                onChange={(e) => onChange({ timeoutSec: Math.max(1, Number(e.target.value || 1)) })}
                className={inputCls}
              />
            </Field>
            <Field label="Initial delay (sec)">
              <input
                type="number"
                min={0}
                value={c.initialDelaySec}
                onChange={(e) => onChange({ initialDelaySec: Math.max(0, Number(e.target.value || 0)) })}
                className={inputCls}
              />
            </Field>
            <Field label="Source rate limit (req/min)">
              <input
                type="number"
                min={0}
                value={c.rateLimitPerMinute}
                onChange={(e) => onChange({ rateLimitPerMinute: Math.max(0, Number(e.target.value || 0)) })}
                className={inputCls}
              />
            </Field>
            <Field label="Source rate burst">
              <input
                type="number"
                min={0}
                value={c.rateLimitBurst}
                onChange={(e) => onChange({ rateLimitBurst: Math.max(0, Number(e.target.value || 0)) })}
                className={inputCls}
              />
            </Field>
            {isRemote ? (
              <>
                <label className="flex items-center gap-2 text-[12px] font-medium text-slate-800 dark:text-slate-200 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={c.remoteRecursive}
                    onChange={(e) => onChange({ remoteRecursive: e.target.checked })}
                  />
                  Recursive directory scan
                </label>
                <Field label="Max files per run">
                  <input
                    type="number"
                    min={1}
                    value={c.maxFilesPerRun}
                    onChange={(e) => onChange({ maxFilesPerRun: Math.max(1, Number(e.target.value || 1)) })}
                    className={inputCls}
                  />
                </Field>
                <Field label="Max file size (MB)">
                  <input
                    type="number"
                    min={1}
                    value={c.maxFileSizeMb}
                    onChange={(e) => onChange({ maxFileSizeMb: Math.max(1, Number(e.target.value || 1)) })}
                    className={inputCls}
                  />
                </Field>
                <Field label="Encoding">
                  <input
                    value={c.encoding}
                    onChange={(e) => onChange({ encoding: e.target.value })}
                    placeholder="utf-8"
                    className={inputCls}
                  />
                </Field>
                <Field label="CSV delimiter">
                  <input
                    value={c.csvDelimiter}
                    onChange={(e) => onChange({ csvDelimiter: e.target.value })}
                    placeholder=","
                    className={`${inputCls} max-w-[80px]`}
                  />
                </Field>
                <Field label="Line event field (line_text)">
                  <input
                    value={c.lineEventField}
                    onChange={(e) => onChange({ lineEventField: e.target.value })}
                    placeholder="line"
                    className={inputCls}
                  />
                </Field>
                <label className="flex items-center gap-2 text-[12px] font-medium text-slate-800 dark:text-slate-200 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={c.includeFileMetadata}
                    onChange={(e) => onChange({ includeFileMetadata: e.target.checked })}
                  />
                  Include file metadata (gdc_remote_* fields on each event)
                </label>
              </>
            ) : !isS3 && !isWebhook ? (
              <div className="md:col-span-2">
                <StreamConfigAdvancedPanels stream={c} onChange={onChange} />
              </div>
            ) : null}
          </div>
          {isS3 ? (
            <p className="mt-3 text-[11px] text-slate-600 dark:text-gdc-muted">
              S3 object polling schedule and limits are controlled here; object selection uses the connector source
              configuration.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">{label}</label>
      {children}
    </div>
  )
}

function KeyValueEditor<T extends { id: string; key: string; value: string }>({
  title,
  rows,
  onChange,
  newRow,
  placeholderKey,
  placeholderValue,
}: {
  title: string
  rows: T[]
  onChange: (rows: T[]) => void
  newRow: () => T
  placeholderKey: string
  placeholderValue: string
}) {
  function update(idx: number, patch: Partial<T>) {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    onChange(next)
  }

  function remove(idx: number) {
    const next = rows.filter((_, i) => i !== idx)
    onChange(next)
  }

  function add() {
    onChange([...rows, newRow()])
  }

  return (
    <div className="rounded-md border border-slate-200/80 bg-slate-50/70 p-2 dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">{title}</p>
        <button
          type="button"
          onClick={add}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-violet-300/60 bg-white px-1.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-500/[0.08] dark:border-violet-500/40 dark:bg-gdc-card dark:text-violet-300 dark:hover:bg-violet-500/15"
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add row
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-1.5 text-[10px] italic text-slate-500">No rows.</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {rows.map((row, idx) => (
            <li key={row.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input
                value={row.key}
                placeholder={placeholderKey}
                onChange={(e) => update(idx, { key: e.target.value } as Partial<T>)}
                className={inputCls}
              />
              <input
                value={row.value}
                placeholder={placeholderValue}
                onChange={(e) => update(idx, { value: e.target.value } as Partial<T>)}
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => remove(idx)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-red-50 hover:text-red-600 dark:border-gdc-border dark:bg-gdc-card"
                aria-label="Remove row"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
