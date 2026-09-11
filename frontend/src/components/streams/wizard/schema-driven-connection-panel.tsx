import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { fetchConnectorRegistryDetail } from '../../../api/gdcConnectorsRegistry'
import { SchemaFormRenderer } from '../../connectors/schema-form/SchemaFormRenderer'
import { buildDefaultValues, normalizeAuthSchema } from '../../connectors/schema-form/schema-form-normalize'
import { validateSchemaForm } from '../../connectors/schema-form/schema-form-validation'
import type { SchemaFormValues } from '../../connectors/schema-form/schema-form-types'
import { normalizeGdcStreamSourceType } from '../../../utils/sourceTypePresentation'
import { mapConnectorApiAuthType, type WizardConnectorState } from './wizard-state'

export type SchemaDrivenConnectionPanelProps = {
  moduleId: string | null
  values: SchemaFormValues
  onValuesChange: (next: SchemaFormValues) => void
  onConnectorPatch: (patch: Partial<WizardConnectorState>) => void
}

function mapSchemaValuesToConnector(values: SchemaFormValues, authType: string): Partial<WizardConnectorState> {
  const mappedAuth = mapConnectorApiAuthType(authType)
  const str = (key: string) => (values[key] == null ? '' : String(values[key]))
  const patch: Partial<WizardConnectorState> = {
    authType: mappedAuth,
    hostBaseUrl: str('base_url'),
    verifySsl: values.verify_ssl !== false,
    httpProxy: str('http_proxy'),
    bearerToken: str('bearer_token') || str('token'),
    basicUsername: str('basic_username') || str('username'),
    basicPassword: str('basic_password') || str('password'),
    apiKeyName: str('api_key_name'),
    apiKeyValue: str('api_key_value'),
    apiKeyLocation: (str('api_key_location') || 'headers') as WizardConnectorState['apiKeyLocation'],
    oauthClientId: str('oauth2_client_id'),
    oauthClientSecret: str('oauth2_client_secret'),
    oauthTokenUrl: str('oauth2_token_url'),
    oauthScope: str('oauth2_scope'),
  }
  return patch
}

export function SchemaDrivenConnectionPanel({
  moduleId,
  values,
  onValuesChange,
  onConnectorPatch,
}: SchemaDrivenConnectionPanelProps) {
  const [loading, setLoading] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [resolvedName, setResolvedName] = useState<string | null>(null)
  const [normalizedSchema, setNormalizedSchema] = useState<ReturnType<typeof normalizeAuthSchema>['schema']>(null)
  const [showValidation, setShowValidation] = useState(false)

  useEffect(() => {
    if (!moduleId) {
      setSchemaError(null)
      setResolvedName(null)
      setNormalizedSchema(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setSchemaError(null)

    void (async () => {
      const detail = await fetchConnectorRegistryDetail(moduleId)
      if (cancelled) return

      if (!detail?.resolved) {
        setSchemaError('Connector module could not be loaded from the registry.')
        setResolvedName(null)
        setNormalizedSchema(null)
        setLoading(false)
        return
      }

      const resolved = detail.resolved
      setResolvedName(resolved.name)

      if (resolved.status === 'invalid') {
        setSchemaError(
          `Module "${resolved.name}" is invalid (${resolved.errors.length} validation issue(s)). Connection form is read-only.`,
        )
      }

      const { schema, error } = normalizeAuthSchema(resolved.auth_schema)
      if (error || !schema) {
        setSchemaError(error ?? 'Auth schema is missing for this connector module.')
        setNormalizedSchema(null)
        setLoading(false)
        return
      }

      setNormalizedSchema(schema)
      const defaults = buildDefaultValues(schema)
      const merged = { ...defaults, ...values }
      onValuesChange(merged)
      onConnectorPatch({
        sourceType: normalizeGdcStreamSourceType(resolved.source_type),
        connectorName: resolved.name,
        ...mapSchemaValuesToConnector(merged, schema.type),
      })
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [moduleId]) // eslint-disable-line react-hooks/exhaustive-deps

  const validationErrors = useMemo(() => {
    if (!normalizedSchema) return []
    return validateSchemaForm(normalizedSchema, values)
  }, [normalizedSchema, values])

  function handleChange(next: SchemaFormValues) {
    onValuesChange(next)
    if (normalizedSchema) {
      onConnectorPatch(mapSchemaValuesToConnector(next, normalizedSchema.type))
    }
    setShowValidation(true)
  }

  if (!moduleId) {
    return (
      <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
        Select a connector module from the catalog to render the connection form from its auth schema.
      </p>
    )
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-slate-600 dark:text-gdc-muted" data-testid="schema-connection-loading">
        <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden />
        Loading auth schema…
      </p>
    )
  }

  if (schemaError && !normalizedSchema) {
    return (
      <div
        className="rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        data-testid="schema-connection-fallback"
        role="alert"
      >
        <p className="font-semibold">Schema unavailable</p>
        <p className="mt-1">{schemaError}</p>
        <p className="mt-2 text-[11px] opacity-90">
          The wizard will continue without crashing. Choose another module or create a generic HTTP connector.
        </p>
      </div>
    )
  }

  if (!normalizedSchema) return null

  const readOnly = Boolean(schemaError)

  return (
    <div className="space-y-3" data-testid="schema-driven-connection-panel">
      {schemaError ? (
        <div
          className="rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          data-testid="schema-connection-warning"
          role="alert"
        >
          {schemaError}
        </div>
      ) : null}
      {resolvedName ? (
        <p className="text-[12px] font-medium text-slate-800 dark:text-slate-200">
          Module: <span data-testid="schema-module-name">{resolvedName}</span>
        </p>
      ) : null}
      <SchemaFormRenderer
        schema={normalizedSchema}
        values={values}
        errors={showValidation ? validationErrors : undefined}
        readOnly={readOnly}
        onChange={handleChange}
      />
    </div>
  )
}
