/**
 * Declarative applicability rules for Full Cross-Product generation.
 * Every rejection MUST cite rule_id + evidence. Unjustified NOT_APPLICABLE is a gate failure.
 */
import type {
  Activation,
  ApplicabilityRuleResult,
  CrossProductAxes,
  DestinationType,
  FaultType,
  RouteTopology,
  SourceAuth,
  SourceType,
  UnknownFieldPolicy,
  UnknownFieldType,
} from './cross-product-types.js'

export type RuleContext = {
  axes: CrossProductAxes
}

export type ApplicabilityRule = {
  rule_id: string
  description: string
  capability_ids: string[]
  evidence: string[]
  /** Return rejected result to exclude; null/undefined means rule does not apply (pass-through). */
  evaluate: (ctx: RuleContext) => ApplicabilityRuleResult | null
}

const HTTP_AUTH = new Set<SourceAuth>([
  'no_auth',
  'basic',
  'bearer',
  'api_key_header',
  'api_key_query',
  'oauth2_client_credentials',
  'session_login',
  'jwt_refresh_token',
  'vendor_jwt_exchange',
])

export const SOURCE_AUTH_MATRIX: Record<SourceType, SourceAuth[]> = {
  HTTP_API_POLLING: [...HTTP_AUTH],
  S3_OBJECT_POLLING: ['s3_keys'],
  DATABASE_QUERY: ['db_password'],
  REMOTE_FILE_POLLING: ['ssh'],
  WEBHOOK_RECEIVER: ['inbound_no_auth', 'inbound_shared_secret_header', 'inbound_bearer_token'],
}

export const DEST_AUTH_MATRIX: Record<DestinationType, CrossProductAxes['destination_auth_protocol'][]> = {
  SYSLOG_UDP: ['NONE'],
  SYSLOG_TCP: ['NONE'],
  SYSLOG_TLS: ['NONE', 'SYSLOG_TLS_MTLS'],
  WEBHOOK_POST: ['NONE'],
}

export const FAULT_SOURCE: Partial<Record<FaultType, SourceType[]>> = {
  http_401: ['HTTP_API_POLLING'],
  http_403: ['HTTP_API_POLLING'],
  http_429: ['HTTP_API_POLLING'],
  http_500: ['HTTP_API_POLLING'],
  http_timeout: ['HTTP_API_POLLING'],
  malformed_response: ['HTTP_API_POLLING'],
  db_disconnect: ['DATABASE_QUERY'],
  s3_unavailable: ['S3_OBJECT_POLLING'],
  sftp_unavailable: ['REMOTE_FILE_POLLING'],
}

export const FAULT_DEST: Partial<Record<FaultType, DestinationType[]>> = {
  webhook_destination_down: ['WEBHOOK_POST'],
  syslog_destination_down: ['SYSLOG_UDP', 'SYSLOG_TCP', 'SYSLOG_TLS'],
  tls_certificate_error: ['SYSLOG_TLS'],
}

export const MULTI_ROUTE_TOPOLOGIES = new Set<RouteTopology>([
  'MULTI_ROUTE_ALL_INHERIT',
  'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE',
  'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE',
  'MULTI_ROUTE_MIXED_POLICY_OVERRIDE',
  'MULTI_ROUTE_MIXED_DESTINATION_TYPE',
  'MULTI_ROUTE_SAME_DESTINATION_TYPE_DIFFERENT_INSTANCE',
  'MULTI_ROUTE_MIXED_DELIVERY_OUTCOME',
  'FAILOVER_ROUTE',
])

/**
 * Browser-reachable route topologies (create-path UI + wizard persist).
 * Complete Transform / Protection / Policy overrides persist at wizard deploy.
 * Incomplete classification (no floor/rule) and incomplete protection (no persistable
 * action) remain Deploy-blocked intent_only drafts — they are not MIXED_* topologies.
 */
export const BROWSER_SUPPORTED_TOPOLOGIES = new Set<RouteTopology>([
  'SINGLE_ROUTE',
  'MULTI_ROUTE_ALL_INHERIT',
  'MULTI_ROUTE_MIXED_DESTINATION_TYPE',
  'MULTI_ROUTE_SAME_DESTINATION_TYPE_DIFFERENT_INSTANCE',
  // Wizard Route Transform Override → canonical route_transform persist
  'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE',
  // Wizard governance persist + Routes Protection panel
  'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE',
  // Wizard Route Policy Override → canonical governance/policy persist
  'MULTI_ROUTE_MIXED_POLICY_OVERRIDE',
  // Per-route deliveryBehavior via protection overrides
  'MULTI_ROUTE_MIXED_DELIVERY_OUTCOME',
  // Wizard Route Processing Delivery → existing failover-routes API
  'FAILOVER_ROUTE',
])

/** Failover configuration lives on Delivery; empty while Browser supports FAILOVER_ROUTE. */
export const BROWSER_NO_FAILOVER_UI_TOPOLOGIES = new Set<RouteTopology>()

export const ROUTE_ON_TOPOLOGIES: RouteTopology[] = [
  'SINGLE_ROUTE',
  'MULTI_ROUTE_ALL_INHERIT',
  'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE',
  'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE',
  'MULTI_ROUTE_MIXED_POLICY_OVERRIDE',
  'MULTI_ROUTE_MIXED_DESTINATION_TYPE',
  'MULTI_ROUTE_SAME_DESTINATION_TYPE_DIFFERENT_INSTANCE',
  'MULTI_ROUTE_MIXED_DELIVERY_OUTCOME',
  'FAILOVER_ROUTE',
]

function reject(
  rule_id: string,
  reason: string,
  capability_ids: string[],
  evidence: string,
): ApplicabilityRuleResult {
  return { rule_id, decision: 'rejected', reason, capability_ids, evidence }
}

function allTransformsOn(a: CrossProductAxes): boolean {
  return (
    a.field_mapping === 'ON' &&
    a.timestamp_normalization === 'ON' &&
    a.jsonata === 'ON' &&
    a.regex === 'ON'
  )
}

function anyTransformOn(a: CrossProductAxes): boolean {
  return (
    a.field_mapping === 'ON' ||
    a.timestamp_normalization === 'ON' ||
    a.jsonata === 'ON' ||
    a.regex === 'ON'
  )
}

/** Frozen NOT_IMPLEMENTED scenario IDs from release-gate baseline (must not change). */
export const NOT_IMPLEMENTED_SCENARIO_IDS: readonly string[] = [
  'auth__auth-destination-webhook-headers__status-partial',
  'dest__destination-ai-provider-post__partial',
  'governance__audit__review__api__route-off',
  'governance__audit__review__api__route-on',
  'governance__governance-delivery-require-review__partial',
  'governance__hash__review__api__route-off',
  'governance__hash__review__api__route-on',
  'governance__mask__review__api__route-off',
  'governance__mask__review__api__route-on',
  'governance__remove__review__api__route-off',
  'governance__remove__review__api__route-on',
  'governance__tokenize__review__api__route-off',
  'governance__tokenize__review__api__route-on',
  'processing__processing-enrichment-lookup__partial',
  'route__routes-per-route-protection-classification-policy__partial',
  'route__routes-per-route-transform__partial',
  'runtime__runtime-fault-injection-fixtures__partial',
  'runtime__runtime-rate-limit__partial',
  'source__source-ai-proxy-receiver__runtime_only',
  'wizard__wizard-step-route-processing__partial',
] as const

/** Capability IDs excluded from cartesian product (NI / PARTIAL / RUNTIME_ONLY / no-op). */
export const EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS: readonly string[] = [
  'auth.destination.webhook_headers',
  'destination.ai_provider_post',
  'governance.delivery.require_review',
  'processing.enrichment.lookup',
  'routes.per_route_protection_classification_policy',
  'routes.per_route_transform',
  'runtime.fault_injection.fixtures',
  'runtime.rate_limit',
  'source.ai_proxy_receiver',
  'wizard.step.route_processing',
] as const

export const APPLICABILITY_RULES: ApplicabilityRule[] = [
  {
    rule_id: 'R001_SOURCE_AUTH_COMPAT',
    description: 'Source authentication must be supported by that source adapter',
    capability_ids: [
      'auth.http.no_auth',
      'auth.http.basic',
      'auth.s3.access_key_secret',
      'auth.database.username_password',
      'auth.remote_file.ssh_password_or_key',
      'auth.webhook_receiver.inbound',
    ],
    evidence: ['app/connectors/auth/registry.py', 'e2e/cross-product/cross-product-axes.yaml#source_auth_matrix'],
    evaluate: ({ axes }) => {
      const allowed = SOURCE_AUTH_MATRIX[axes.source_type] || []
      if (!allowed.includes(axes.source_auth)) {
        return reject(
          'R001_SOURCE_AUTH_COMPAT',
          `source_auth=${axes.source_auth} not supported for source_type=${axes.source_type}`,
          ['auth.http.basic', 'source.http_api_polling'],
          'SOURCE_AUTH_MATRIX',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R002_SOURCE_CONFIG_PROFILE',
    description: 'Source configuration profile must match adapter collection mode',
    capability_ids: ['source.http_api_polling', 'source.webhook_receiver'],
    evidence: ['app/sources/adapters/registry.py', 'app/scheduler/scheduler.py'],
    evaluate: ({ axes }) => {
      if (axes.source_type === 'WEBHOOK_RECEIVER' && axes.source_configuration_profile !== 'WEBHOOK_PUSH') {
        return reject(
          'R002_SOURCE_CONFIG_PROFILE',
          'WEBHOOK_RECEIVER requires WEBHOOK_PUSH configuration profile',
          ['source.webhook_receiver'],
          'collection_mode=PUSH',
        )
      }
      if (axes.source_type !== 'WEBHOOK_RECEIVER' && axes.source_configuration_profile === 'WEBHOOK_PUSH') {
        return reject(
          'R002_SOURCE_CONFIG_PROFILE',
          'WEBHOOK_PUSH profile only valid for WEBHOOK_RECEIVER',
          ['source.http_api_polling'],
          'collection_mode=POLLING',
        )
      }
      if (axes.incremental_fetch === 'ON' && axes.source_configuration_profile === 'DEFAULT') {
        return reject(
          'R002_SOURCE_CONFIG_PROFILE',
          'incremental_fetch=ON requires INCREMENTAL_READY profile',
          ['runtime.incremental_fetch'],
          'app/runtime/incremental_fetch.py',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R003_POLLING_NOT_ON_WEBHOOK',
    description: 'Polling settings are not applicable to webhook receiver',
    capability_ids: ['source.webhook_receiver'],
    evidence: ['app/runners/webhook_receiver.py'],
    evaluate: ({ axes }) => {
      if (axes.source_type === 'WEBHOOK_RECEIVER' && axes.collection_mode === 'POLLING') {
        return reject(
          'R003_POLLING_NOT_ON_WEBHOOK',
          'WEBHOOK_RECEIVER cannot use POLLING collection_mode',
          ['source.webhook_receiver'],
          'app/runners/webhook_receiver.py',
        )
      }
      if (axes.source_type !== 'WEBHOOK_RECEIVER' && axes.collection_mode === 'PUSH') {
        return reject(
          'R003_POLLING_NOT_ON_WEBHOOK',
          'PUSH collection_mode only for WEBHOOK_RECEIVER',
          ['source.http_api_polling'],
          'app/scheduler/scheduler.py',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R004_INCREMENTAL_CHECKPOINT_SOURCE',
    description: 'Incremental fetch and checkpoint only on polling sources',
    capability_ids: ['runtime.incremental_fetch', 'runtime.checkpoint'],
    evidence: ['app/runtime/incremental_fetch.py', 'e2e/capabilities/data-relay-capabilities.yaml'],
    evaluate: ({ axes }) => {
      if (axes.source_type === 'WEBHOOK_RECEIVER' && axes.incremental_fetch === 'ON') {
        return reject(
          'R004_INCREMENTAL_CHECKPOINT_SOURCE',
          'WEBHOOK_RECEIVER does not support incremental_fetch',
          ['source.webhook_receiver', 'runtime.incremental_fetch'],
          'manifest incremental_fetch:false',
        )
      }
      if (axes.incremental_fetch === 'OFF' && axes.checkpoint_strategy !== 'NONE') {
        return reject(
          'R004_INCREMENTAL_CHECKPOINT_SOURCE',
          'checkpoint_strategy requires incremental_fetch=ON',
          ['runtime.checkpoint'],
          'app/runtime/incremental_fetch.py',
        )
      }
      if (axes.incremental_fetch === 'ON' && axes.checkpoint_strategy === 'NONE') {
        return reject(
          'R004_INCREMENTAL_CHECKPOINT_SOURCE',
          'incremental_fetch=ON requires WATERMARK_OR_CURSOR checkpoint',
          ['runtime.checkpoint'],
          'app/runtime/incremental_fetch.py',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R005_SOURCE_DEST_UNRESTRICTED',
    description: 'Source×Destination unrestricted unless product constraint exists (always allow when reached)',
    capability_ids: ['source.http_api_polling', 'destination.webhook_post'],
    evidence: ['Product charter: One Stream → Many Routes → Many Destinations'],
    evaluate: () => null,
  },
  {
    rule_id: 'R006_ROUTE_OFF_NO_OVERRIDE',
    description: 'route-off: multi-route and route overrides are NOT_APPLICABLE',
    capability_ids: ['flag.gdc_route_processing_enabled'],
    evidence: ['app/config.py GDC_ROUTE_PROCESSING_ENABLED', 'app/runners/stream_runner.py'],
    evaluate: ({ axes }) => {
      if (axes.route_runtime !== 'ROUTE_OFF') return null
      if (MULTI_ROUTE_TOPOLOGIES.has(axes.route_topology)) {
        return reject(
          'R006_ROUTE_OFF_NO_OVERRIDE',
          `route_topology=${axes.route_topology} requires ROUTE_ON`,
          ['flag.gdc_route_processing_enabled'],
          'GDC_ROUTE_PROCESSING_ENABLED=false uses legacy shared transform',
        )
      }
      if (
        axes.route_transform_override === 'ON' ||
        axes.route_protection_override === 'ON' ||
        axes.route_classification_override === 'ON' ||
        axes.route_policy_override === 'ON'
      ) {
        return reject(
          'R006_ROUTE_OFF_NO_OVERRIDE',
          'Route overrides require ROUTE_ON',
          ['flag.gdc_route_processing_enabled'],
          'app/runners/route_context.py',
        )
      }
      if (axes.route_inheritance !== 'NOT_APPLICABLE' && axes.route_topology === 'SINGLE_ROUTE') {
        // inheritance axis must be NA under route-off
        if (axes.route_inheritance !== 'NOT_APPLICABLE') {
          return reject(
            'R006_ROUTE_OFF_NO_OVERRIDE',
            'route_inheritance must be NOT_APPLICABLE when ROUTE_OFF',
            ['flag.gdc_route_processing_enabled'],
            'legacy fan-out has no per-route inheritance',
          )
        }
      }
      return null
    },
  },
  {
    rule_id: 'R007_ROUTE_ON_TOPOLOGY',
    description: 'route-on: single and all supported multi-route profiles allowed',
    capability_ids: ['routes.architecture.one_stream_many_routes'],
    evidence: ['app/runners/route_context.py'],
    evaluate: ({ axes }) => {
      if (axes.route_runtime !== 'ROUTE_ON') return null
      if (!ROUTE_ON_TOPOLOGIES.includes(axes.route_topology)) {
        return reject(
          'R007_ROUTE_ON_TOPOLOGY',
          `Unknown route_topology=${axes.route_topology}`,
          ['routes.architecture.one_stream_many_routes'],
          'cross-product-axes.yaml#route_topology',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R008_GOVERNANCE_REQUIRED_FOR_PROTECTION',
    description: 'Protection/delivery control require governance-capable configuration',
    capability_ids: ['flag.gdc_protection_enabled', 'governance.delivery.continue'],
    evidence: ['app/stream_governance/constants.py', 'app/protection/engine.py'],
    evaluate: () => null, // protection axes are always within SUPPORTED governance set
  },
  {
    rule_id: 'R009_SENSITIVE_PROTECTION_REQUIRES_TARGET',
    description: 'Sensitive-only protection not applied when no sensitive detection target',
    capability_ids: ['governance.sensitive_detection', 'governance.protection.mask'],
    evidence: ['app/stream_governance/constants.py'],
    evaluate: ({ axes }) => {
      if (
        axes.sensitive_detection_profile === 'OFF' &&
        axes.unknown_field_type === 'SENSITIVE' &&
        axes.unknown_field_policy === 'AUTO_PROTECT'
      ) {
        return reject(
          'R009_SENSITIVE_PROTECTION_REQUIRES_TARGET',
          'AUTO_PROTECT requires sensitive_detection_profile=ON',
          ['governance.sensitive_detection'],
          'UNKNOWN_SENSITIVE_POLICIES auto_protect',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R010_UNKNOWN_NORMAL_VS_SENSITIVE',
    description: 'Unknown Normal and Unknown Sensitive are separated',
    capability_ids: ['governance.schema_drift'],
    evidence: ['app/schema_drift_policy/schemas.py'],
    evaluate: ({ axes }) => {
      if (axes.unknown_field_type === 'NONE' && axes.unknown_field_policy !== 'NONE') {
        return reject(
          'R010_UNKNOWN_NORMAL_VS_SENSITIVE',
          'unknown_field_policy requires unknown_field_type ≠ NONE',
          ['governance.schema_drift'],
          'UNKNOWN_NORMAL_POLICIES / UNKNOWN_SENSITIVE_POLICIES',
        )
      }
      if (axes.unknown_field_type !== 'NONE' && axes.unknown_field_policy === 'NONE') {
        return reject(
          'R010_UNKNOWN_NORMAL_VS_SENSITIVE',
          'unknown_field_type set requires a concrete policy',
          ['governance.schema_drift'],
          'app/schema_drift_policy/schemas.py',
        )
      }
      if (axes.unknown_field_type === 'NORMAL' && axes.unknown_field_policy === 'AUTO_PROTECT') {
        return reject(
          'R010_UNKNOWN_NORMAL_VS_SENSITIVE',
          'AUTO_PROTECT is sensitive-only policy',
          ['governance.schema_drift'],
          'UNKNOWN_SENSITIVE_POLICIES',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R011_AUTO_PROTECT_REQUIRES_SENSITIVE_MATCH',
    description: 'Unknown Sensitive Auto Protect only when sensitive detection match exists',
    capability_ids: ['governance.sensitive_detection', 'governance.schema_drift'],
    evidence: ['app/schema_drift_policy/schemas.py'],
    evaluate: ({ axes }) => {
      if (
        axes.unknown_field_policy === 'AUTO_PROTECT' &&
        (axes.unknown_field_type !== 'SENSITIVE' || axes.sensitive_detection_profile !== 'ON')
      ) {
        return reject(
          'R011_AUTO_PROTECT_REQUIRES_SENSITIVE_MATCH',
          'AUTO_PROTECT requires unknown_field_type=SENSITIVE and sensitive_detection=ON',
          ['governance.sensitive_detection'],
          'UNKNOWN_SENSITIVE_POLICIES.auto_protect',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R012_BLOCK_NO_COLLECTOR',
    description: 'Block expects collector 0 and destination adapter not invoked (oracle expectation)',
    capability_ids: ['governance.delivery.block'],
    evidence: ['app/route_policy/governance_behavior.py'],
    evaluate: () => null, // expectation enforced by oracle, not rejection
  },
  {
    rule_id: 'R013_QUARANTINE_STORAGE',
    description: 'Quarantine expects collector 0 and quarantine storage (oracle expectation)',
    capability_ids: ['governance.delivery.quarantine'],
    evidence: ['app/governance_quarantine/'],
    evaluate: () => null,
  },
  {
    rule_id: 'R014_CONTINUE_PAYLOAD',
    description: 'Continue expects per-route final payload at collector (oracle expectation)',
    capability_ids: ['governance.delivery.continue'],
    evidence: ['app/delivery/'],
    evaluate: () => null,
  },
  {
    rule_id: 'R015_DEST_AUTH_PROTOCOL',
    description: 'Destination auth/protocol must be supported by destination type',
    capability_ids: ['destination.syslog_tls', 'destination.webhook_post', 'auth.destination.syslog_tls_client_cert'],
    evidence: ['app/destinations/schemas.py', 'app/delivery/syslog_tls.py'],
    evaluate: ({ axes }) => {
      if (axes.destination_auth_protocol === 'WEBHOOK_HEADERS_UNSUPPORTED') {
        return reject(
          'R015_DEST_AUTH_PROTOCOL',
          'Webhook destination headers auth is PARTIAL (UI missing) — excluded from product execution',
          ['auth.destination.webhook_headers'],
          'Destinations create-form has no headers editor',
        )
      }
      const allowed = DEST_AUTH_MATRIX[axes.destination_type] || []
      if (!allowed.includes(axes.destination_auth_protocol)) {
        return reject(
          'R015_DEST_AUTH_PROTOCOL',
          `destination_auth_protocol=${axes.destination_auth_protocol} invalid for ${axes.destination_type}`,
          ['destination.syslog_tls'],
          'DEST_AUTH_MATRIX',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R016_TLS_FAULT_DEST',
    description: 'TLS fault only valid for TLS destination',
    capability_ids: ['destination.syslog_tls'],
    evidence: ['e2e/framework/fault-injector.ts', 'e2e/lab/fault-inject.sh'],
    evaluate: ({ axes }) => {
      if (axes.fault_type === 'tls_certificate_error' && axes.destination_type !== 'SYSLOG_TLS') {
        return reject(
          'R016_TLS_FAULT_DEST',
          'tls_certificate_error requires SYSLOG_TLS destination',
          ['destination.syslog_tls'],
          'fault_destination_matrix',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R017_HTTP_FAULT_SOURCE',
    description: 'HTTP 401/403/429/500/timeout/invalid JSON faults only for HTTP source',
    capability_ids: ['source.http_api_polling'],
    evidence: ['e2e/lab/fixtures/http/mappings/fault-*.json'],
    evaluate: ({ axes }) => {
      const httpFaults: FaultType[] = [
        'http_401',
        'http_403',
        'http_429',
        'http_500',
        'http_timeout',
        'malformed_response',
      ]
      if (httpFaults.includes(axes.fault_type) && axes.source_type !== 'HTTP_API_POLLING') {
        return reject(
          'R017_HTTP_FAULT_SOURCE',
          `${axes.fault_type} requires HTTP_API_POLLING source`,
          ['source.http_api_polling'],
          'fault_source_matrix',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R018_DB_S3_SFTP_FAULT_SOURCE',
    description: 'DB/S3/SFTP faults only for matching source',
    capability_ids: ['source.database_query_postgresql', 'source.s3_object_polling', 'source.remote_file_polling'],
    evidence: ['e2e/lab/fault-inject.sh'],
    evaluate: ({ axes }) => {
      const map = FAULT_SOURCE[axes.fault_type]
      if (map && !map.includes(axes.source_type)) {
        return reject(
          'R018_DB_S3_SFTP_FAULT_SOURCE',
          `${axes.fault_type} not applicable to ${axes.source_type}`,
          ['runtime.fault_injection.fixtures'],
          'fault_source_matrix',
        )
      }
      const dmap = FAULT_DEST[axes.fault_type]
      if (dmap && !dmap.includes(axes.destination_type)) {
        return reject(
          'R018_DB_S3_SFTP_FAULT_SOURCE',
          `${axes.fault_type} not applicable to destination ${axes.destination_type}`,
          ['runtime.fault_injection.fixtures'],
          'fault_destination_matrix',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019a_BROWSER_SOURCE_UI',
    description: 'Browser Source UI must support the source_type (all current product sources are supported)',
    capability_ids: [
      'source.http_api_polling',
      'source.s3_object_polling',
      'source.database_query_postgresql',
      'source.remote_file_polling',
      'source.webhook_receiver',
      'test.playwright.browser_e2e',
    ],
    evidence: [
      'frontend/src/components/connectors/new-connector-wizard-page.tsx',
      'frontend/src/utils/sourceTypePresentation.ts',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      const supported: SourceType[] = [
        'HTTP_API_POLLING',
        'S3_OBJECT_POLLING',
        'DATABASE_QUERY',
        'REMOTE_FILE_POLLING',
        'WEBHOOK_RECEIVER',
      ]
      if (!supported.includes(axes.source_type)) {
        return reject(
          'R019a_BROWSER_SOURCE_UI',
          `Browser Source UI does not support source_type=${axes.source_type}`,
          ['test.playwright.browser_e2e'],
          'new-connector-wizard-page.tsx source type radios',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019b_BROWSER_AUTH_UI',
    description: 'Browser Auth UI must support source_auth (current SOURCE_AUTH_MATRIX values are UI-mappable)',
    capability_ids: ['auth.http.basic', 'auth.webhook_receiver.inbound', 'test.playwright.browser_e2e'],
    evidence: [
      'frontend/src/components/connectors/generic-http-auth-fields.tsx',
      'frontend/src/components/connectors/webhook-receiver-fields.tsx',
      'frontend/src/components/connectors/s3-connector-fields.tsx',
      'frontend/src/components/connectors/database-connector-fields.tsx',
      'frontend/src/components/connectors/remote-file-connector-fields.tsx',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      const allowed = SOURCE_AUTH_MATRIX[axes.source_type] || []
      if (!allowed.includes(axes.source_auth)) {
        return reject(
          'R019b_BROWSER_AUTH_UI',
          `Browser Auth UI does not support source_auth=${axes.source_auth} for ${axes.source_type}`,
          ['test.playwright.browser_e2e'],
          'SOURCE_AUTH_MATRIX ∩ connector wizard fields',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019c_BROWSER_DEST_UI',
    description: 'Browser Destination UI must support destination_type + auth protocol',
    capability_ids: [
      'destination.webhook_post',
      'destination.syslog_udp',
      'destination.syslog_tcp',
      'destination.syslog_tls',
      'test.playwright.browser_e2e',
    ],
    evidence: ['frontend/src/components/destinations/destinations-management-page.tsx'],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      const supportedDest: DestinationType[] = ['WEBHOOK_POST', 'SYSLOG_UDP', 'SYSLOG_TCP', 'SYSLOG_TLS']
      if (!supportedDest.includes(axes.destination_type)) {
        return reject(
          'R019c_BROWSER_DEST_UI',
          `Browser Destination UI does not support destination_type=${axes.destination_type}`,
          ['test.playwright.browser_e2e'],
          'destinations-management-page.tsx destination type select',
        )
      }
      const allowed = DEST_AUTH_MATRIX[axes.destination_type] || []
      if (!allowed.includes(axes.destination_auth_protocol)) {
        return reject(
          'R019c_BROWSER_DEST_UI',
          `Browser Destination UI does not support destination_auth_protocol=${axes.destination_auth_protocol}`,
          ['test.playwright.browser_e2e'],
          'destinations-management-page.tsx TLS mTLS optional fields',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019d_BROWSER_TRANSFORM_UI',
    description:
      'Browser Transform UI supports stream-level transforms and per-route Transform Override persist (route_transform)',
    capability_ids: [
      'processing.mapping.field_jsonpath',
      'processing.enrichment.jsonata',
      'processing.mapping.full_event_regex',
      'routes.per_route_transform',
      'test.playwright.browser_e2e',
    ],
    evidence: [
      'frontend/src/components/streams/wizard/step-mapping-combined.tsx',
      'frontend/src/components/streams/wizard/wizard-transform-persist.ts',
      'frontend/src/components/streams/wizard/wizard-deploy-projection.ts persistKind route_transform',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      // MIXED_TRANSFORM_OVERRIDE is Browser-supported: Wizard persistKind=route_transform.
      // Incomplete transform drafts (override flag without payload) are Deploy-blocked
      // intent_only and are not this topology.
      return null
    },
  },
  {
    rule_id: 'R019e_BROWSER_GOVERNANCE_UI',
    description:
      'Browser Governance UI supports protection/delivery/classification; protection override topologies allowed via governance persist',
    capability_ids: [
      'governance.protection.audit',
      'governance.delivery.continue',
      'governance.classification',
      'test.playwright.browser_e2e',
    ],
    evidence: [
      'frontend/src/components/streams/wizard/step-data-protection.tsx',
      'frontend/src/components/streams/wizard/wizard-governance-persist.ts',
      'frontend/src/components/routes/route-edit-page.tsx ProtectionPanel',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      // Current protection_action / delivery_behavior axis values are all UI-selectable.
      const protections = new Set(['audit', 'mask_partial', 'tokenize', 'hash', 'drop_field'])
      const deliveries = new Set(['continue', 'quarantine', 'block'])
      if (!protections.has(axes.protection_action)) {
        return reject(
          'R019e_BROWSER_GOVERNANCE_UI',
          `Browser Governance UI does not support protection_action=${axes.protection_action}`,
          ['test.playwright.browser_e2e'],
          'step-data-protection.tsx protection select',
        )
      }
      if (!deliveries.has(axes.delivery_behavior)) {
        return reject(
          'R019e_BROWSER_GOVERNANCE_UI',
          `Browser Governance UI does not support delivery_behavior=${axes.delivery_behavior}`,
          ['test.playwright.browser_e2e'],
          'step-data-protection.tsx delivery behavior select',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019f_BROWSER_ROUTE_OVERRIDE_UI',
    description:
      'Browser Route Override UI: inherit/dest-mix/transform/protection/policy/delivery/failover allowed',
    capability_ids: [
      'routes.architecture.one_stream_many_routes',
      'routes.per_route_protection_classification_policy',
      'wizard.step.route_processing',
      'test.playwright.browser_e2e',
    ],
    evidence: [
      'frontend/src/components/streams/wizard/wizard-stream-hydrate.ts',
      'frontend/src/components/streams/wizard/wizard-deploy-projection.ts persistKind governance for policy',
      'frontend/src/components/streams/wizard/wizard-policy-persist.ts',
      'frontend/src/components/streams/route-processing/wizard-route-processing-detail-panel.tsx route-failover-configuration',
      'frontend/src/components/streams/wizard/wizard-failover-persist.ts',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      if (BROWSER_NO_FAILOVER_UI_TOPOLOGIES.has(axes.route_topology)) {
        return reject(
          'R019f_BROWSER_ROUTE_OVERRIDE_UI',
          'Browser has no dedicated failover route configuration UI',
          ['routes.architecture.one_stream_many_routes'],
          'no failover controls under frontend/src/components/routes/',
        )
      }
      if (!BROWSER_SUPPORTED_TOPOLOGIES.has(axes.route_topology)) {
        return reject(
          'R019f_BROWSER_ROUTE_OVERRIDE_UI',
          `Browser cannot configure route_topology=${axes.route_topology}`,
          ['wizard.step.route_processing'],
          'BROWSER_SUPPORTED_TOPOLOGIES',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R019g_BROWSER_FAULT_UI',
    description: 'Browser cannot configure fault injection — lab fault-inject is API/ops only',
    capability_ids: ['runtime.fault_injection.fixtures', 'test.playwright.browser_e2e'],
    evidence: [
      'e2e/lab/fault-inject.sh',
      'e2e/framework/fault-injector.ts',
      'no frontend fault injection controls',
    ],
    evaluate: ({ axes }) => {
      if (axes.execution_surface !== 'BROWSER') return null
      if (axes.fault_type !== 'NONE') {
        return reject(
          'R019g_BROWSER_FAULT_UI',
          `Browser cannot configure fault_type=${axes.fault_type} (no UI; lab fault-inject only)`,
          ['runtime.fault_injection.fixtures', 'test.playwright.browser_e2e'],
          'e2e/lab/fault-inject.sh',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R020_BROWSER_NA_KEEP_API',
    description: 'UI-missing settings mark Browser NOT_APPLICABLE only; API scenarios remain',
    capability_ids: ['auth.destination.webhook_headers'],
    evidence: ['frontend destinations-management-page.tsx'],
    evaluate: () => null, // handled by R015/R019*; API path stays
  },
  {
    rule_id: 'R021_EXCLUDE_NOT_IMPLEMENTED',
    description: 'NOT_IMPLEMENTED capabilities are not included in cartesian product',
    capability_ids: [...EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS],
    evidence: ['e2e/release-gate/baseline/not-implemented-baseline.json'],
    evaluate: () => null, // enforced by axis registry exclusion
  },
  {
    rule_id: 'R022_NI_SET_IMMUTABLE',
    description: 'Existing NOT_IMPLEMENTED 20 scenario ID set must not change',
    capability_ids: [...EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS],
    evidence: ['e2e/release-gate/baseline/not-implemented-baseline.json'],
    evaluate: () => null, // validated in validate-cross-product / gate
  },
  {
    rule_id: 'R023_NO_UNJUSTIFIED_NA',
    description: 'NOT_APPLICABLE without rule_id/evidence is forbidden',
    capability_ids: [],
    evidence: ['e2e/cross-product/applicability-rules.ts'],
    evaluate: () => null, // meta-rule enforced by generator + gate
  },
  {
    rule_id: 'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
    description: 'Route override flags must align with topology profile',
    capability_ids: ['routes.architecture.one_stream_many_routes'],
    evidence: ['app/runners/route_context.py'],
    evaluate: ({ axes }) => {
      const topo = axes.route_topology
      const needTransform = topo === 'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE'
      const needProtection = topo === 'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE'
      const needPolicy = topo === 'MULTI_ROUTE_MIXED_POLICY_OVERRIDE'
      if (needTransform && axes.route_transform_override !== 'ON') {
        return reject(
          'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
          'MIXED_TRANSFORM_OVERRIDE requires route_transform_override=ON',
          ['routes.per_route_transform'],
          'route_topology profile contract',
        )
      }
      if (needProtection && axes.route_protection_override !== 'ON') {
        return reject(
          'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
          'MIXED_PROTECTION_OVERRIDE requires route_protection_override=ON',
          ['routes.per_route_protection_classification_policy'],
          'route_topology profile contract',
        )
      }
      if (needPolicy && axes.route_policy_override !== 'ON') {
        return reject(
          'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
          'MIXED_POLICY_OVERRIDE requires route_policy_override=ON',
          ['routes.per_route_protection_classification_policy'],
          'route_topology profile contract',
        )
      }
      if (topo === 'MULTI_ROUTE_ALL_INHERIT' || topo === 'SINGLE_ROUTE') {
        if (
          axes.route_transform_override === 'ON' ||
          axes.route_protection_override === 'ON' ||
          axes.route_policy_override === 'ON'
        ) {
          return reject(
            'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
            `${topo} requires all route overrides OFF`,
            ['routes.architecture.one_stream_many_routes'],
            'route_topology profile contract',
          )
        }
      }
      if (topo === 'FAILOVER_ROUTE' && axes.failover_mode === 'NONE') {
        return reject(
          'R024_TOPOLOGY_OVERRIDE_ALIGNMENT',
          'FAILOVER_ROUTE requires failover_mode=FAILOVER_ON_DESTINATION_FAILURE',
          ['routes.architecture.one_stream_many_routes'],
          'failover_eligibility.py',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R025_FAULT_RUNTIME_CONDITION',
    description: 'runtime_condition and replay_mode must align with fault_type',
    capability_ids: ['governance.replay'],
    evidence: ['app/governance_replay/'],
    evaluate: ({ axes }) => {
      if (axes.fault_type === 'NONE') {
        if (axes.runtime_condition !== 'NOMINAL') {
          return reject(
            'R025_FAULT_RUNTIME_CONDITION',
            'fault_type=NONE requires runtime_condition=NOMINAL',
            ['runtime.fault_injection.fixtures'],
            'derived axis alignment',
          )
        }
        if (axes.replay_mode !== 'NONE') {
          return reject(
            'R025_FAULT_RUNTIME_CONDITION',
            'replay without fault is not in scope for this product',
            ['governance.replay'],
            'replay_mode paired with fault recovery',
          )
        }
      } else {
        if (axes.runtime_condition !== 'FAULT_INJECTED') {
          return reject(
            'R025_FAULT_RUNTIME_CONDITION',
            'non-NONE fault requires runtime_condition=FAULT_INJECTED',
            ['runtime.fault_injection.fixtures'],
            'derived axis alignment',
          )
        }
      }
      if (axes.failover_mode === 'FAILOVER_ON_DESTINATION_FAILURE' && axes.route_topology !== 'FAILOVER_ROUTE') {
        return reject(
          'R025_FAULT_RUNTIME_CONDITION',
          'failover_mode requires FAILOVER_ROUTE topology',
          ['routes.architecture.one_stream_many_routes'],
          'failover_eligibility.py',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R026_PARTIAL_TRANSFORM_SCOPE',
    description:
      'Partial transform activation isolates composition with baseline governance; full governance×transform cross uses all-ON chain',
    capability_ids: [
      'processing.mapping.field_jsonpath',
      'processing.enrichment.timestamp_conversion',
      'processing.enrichment.jsonata',
      'processing.mapping.full_event_regex',
      'governance.protection.audit',
      'governance.delivery.continue',
    ],
    evidence: [
      '목표 상태 complex chain requires simultaneous transforms',
      'Partial OFF combos isolate transform composition without governance explosion',
    ],
    evaluate: ({ axes }) => {
      if (allTransformsOn(axes)) return null
      if (axes.protection_action !== 'audit' || axes.delivery_behavior !== 'continue') {
        return reject(
          'R026_PARTIAL_TRANSFORM_SCOPE',
          'Partial transform combos use protection=audit and delivery=continue only; full protection×delivery cross requires all transforms ON',
          ['governance.protection.audit', 'governance.delivery.continue'],
          'R026_PARTIAL_TRANSFORM_SCOPE',
        )
      }
      if (MULTI_ROUTE_TOPOLOGIES.has(axes.route_topology)) {
        return reject(
          'R026_PARTIAL_TRANSFORM_SCOPE',
          'Multi-route topologies require all transforms ON so per-route effective config diffs are observable',
          ['routes.architecture.one_stream_many_routes'],
          'R026_PARTIAL_TRANSFORM_SCOPE',
        )
      }
      if (axes.fault_type !== 'NONE') {
        return reject(
          'R026_PARTIAL_TRANSFORM_SCOPE',
          'Fault/recovery combinations require full transform chain (all ON)',
          ['runtime.fault_injection.fixtures'],
          'R026_PARTIAL_TRANSFORM_SCOPE',
        )
      }
      if (axes.unknown_field_policy !== 'PASS_THROUGH' && axes.unknown_field_type !== 'NONE') {
        // allow NONE/NONE; for drift unknowns in partial transforms only PASS_THROUGH
        if (axes.unknown_field_type !== 'NONE' && axes.unknown_field_policy !== 'PASS_THROUGH') {
          return reject(
            'R026_PARTIAL_TRANSFORM_SCOPE',
            'Partial transform combos use unknown_field_policy=PASS_THROUGH only',
            ['governance.schema_drift'],
            'R026_PARTIAL_TRANSFORM_SCOPE',
          )
        }
      }
      return null
    },
  },
  {
    rule_id: 'R027_CLASSIFICATION_ALIGNMENT',
    description: 'Classification CONFIDENTIAL requires sensitive detection ON',
    capability_ids: ['governance.classification', 'flag.gdc_classification_enabled'],
    evidence: ['app/stream_governance/'],
    evaluate: ({ axes }) => {
      if (axes.classification_profile === 'CONFIDENTIAL' && axes.sensitive_detection_profile !== 'ON') {
        return reject(
          'R027_CLASSIFICATION_ALIGNMENT',
          'CONFIDENTIAL classification requires sensitive_detection_profile=ON',
          ['governance.classification'],
          'classification feeds from sensitive detection',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R028_FAULT_CHAIN_PARTNERS',
    description:
      'Fault/recovery product uses composite-chain partners so checkpoint non-advance, dedup, and replay assertions are meaningful',
    capability_ids: ['runtime.checkpoint', 'runtime.dedup', 'governance.replay'],
    evidence: [
      'app/runners/stream_runner.py _update_checkpoint_after_success',
      'app/runners/stream_dedup.py REGISTRY_RECORD_STAGE=delivery_success',
      'e2e/cross-product/governance-bundles.ts FAULT_CHAIN_*',
    ],
    evaluate: ({ axes }) => {
      if (axes.fault_type === 'NONE') return null
      if (axes.field_mapping !== 'ON' || axes.timestamp_normalization !== 'ON' || axes.jsonata !== 'ON' || axes.regex !== 'ON') {
        return reject(
          'R028_FAULT_CHAIN_PARTNERS',
          'Fault scenarios require full transform chain ON',
          ['runtime.fault_injection.fixtures'],
          'R028_FAULT_CHAIN_PARTNERS',
        )
      }
      if (axes.protection_action !== 'audit' || axes.delivery_behavior !== 'continue') {
        return reject(
          'R028_FAULT_CHAIN_PARTNERS',
          'Fault scenarios use protection=audit delivery=continue (delivery outcome asserted via continue path)',
          ['governance.delivery.continue'],
          'R028_FAULT_CHAIN_PARTNERS',
        )
      }
      return null
    },
  },
  {
    rule_id: 'R029_ORTHOGONAL_DOMAIN_PRODUCTS',
    description:
      'Independent config domains (transform composition, protection×delivery, governance bundles, collection, fault) are expanded as full products against composite-chain baselines — not pairwise sampling of axis values',
    capability_ids: [
      'processing.mapping.field_jsonpath',
      'governance.protection.audit',
      'governance.schema_drift',
      'runtime.dedup',
    ],
    evidence: [
      'e2e/cross-product/generate-cross-product.ts iterateCandidateAxes products 1/2a/2b/2c/3',
      'Each domain enumerates ALL of its values; partners are chain baselines required for oracle contracts',
    ],
    evaluate: () => null,
  },
]

export function evaluateApplicability(axes: CrossProductAxes): ApplicabilityRuleResult | null {
  for (const rule of APPLICABILITY_RULES) {
    const result = rule.evaluate({ axes })
    if (result && result.decision === 'rejected') return result
  }
  return null
}

export function deriveDependentAxes(
  partial: Pick<
    CrossProductAxes,
    | 'execution_surface'
    | 'route_runtime'
    | 'source_type'
    | 'source_auth'
    | 'destination_type'
    | 'destination_auth_protocol'
    | 'route_topology'
    | 'field_mapping'
    | 'timestamp_normalization'
    | 'jsonata'
    | 'regex'
    | 'protection_action'
    | 'delivery_behavior'
    | 'incremental_fetch'
    | 'dedup_strategy'
    | 'unknown_field_type'
    | 'unknown_field_policy'
    | 'sensitive_detection_profile'
    | 'classification_profile'
    | 'fault_type'
    | 'replay_mode'
    | 'failover_mode'
  >,
): CrossProductAxes {
  const isWebhook = partial.source_type === 'WEBHOOK_RECEIVER'
  const collection_mode = isWebhook ? 'PUSH' : 'POLLING'
  const source_configuration_profile = isWebhook
    ? 'WEBHOOK_PUSH'
    : partial.incremental_fetch === 'ON'
      ? 'INCREMENTAL_READY'
      : 'DEFAULT'
  const checkpoint_strategy =
    partial.incremental_fetch === 'ON' ? 'WATERMARK_OR_CURSOR' : 'NONE'

  let route_inheritance: CrossProductAxes['route_inheritance'] = 'NOT_APPLICABLE'
  let route_transform_override: Activation = 'OFF'
  let route_protection_override: Activation = 'OFF'
  let route_classification_override: Activation = 'OFF'
  let route_policy_override: Activation = 'OFF'

  if (partial.route_runtime === 'ROUTE_ON') {
    switch (partial.route_topology) {
      case 'SINGLE_ROUTE':
      case 'MULTI_ROUTE_ALL_INHERIT':
        route_inheritance = 'ALL_INHERIT'
        break
      case 'MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE':
        route_inheritance = 'MIXED_OVERRIDE'
        route_transform_override = 'ON'
        break
      case 'MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE':
        route_inheritance = 'MIXED_OVERRIDE'
        route_protection_override = 'ON'
        break
      case 'MULTI_ROUTE_MIXED_POLICY_OVERRIDE':
        route_inheritance = 'MIXED_OVERRIDE'
        route_policy_override = 'ON'
        break
      case 'MULTI_ROUTE_MIXED_DELIVERY_OUTCOME':
        route_inheritance = 'MIXED_OVERRIDE'
        route_protection_override = 'ON'
        route_policy_override = 'ON'
        break
      case 'MULTI_ROUTE_MIXED_DESTINATION_TYPE':
      case 'MULTI_ROUTE_SAME_DESTINATION_TYPE_DIFFERENT_INSTANCE':
        route_inheritance = 'ALL_INHERIT'
        break
      case 'FAILOVER_ROUTE':
        route_inheritance = 'MIXED_OVERRIDE'
        break
      default:
        route_inheritance = 'ALL_INHERIT'
    }
  }

  const runtime_condition = partial.fault_type === 'NONE' ? 'NOMINAL' : 'FAULT_INJECTED'

  return {
    ...partial,
    source_configuration_profile,
    collection_mode,
    payload_format: 'JSON',
    record_path_event_root_profile:
      partial.source_type === 'HTTP_API_POLLING' ? 'NESTED_DATA_EVENTS' : 'ROOT_ARRAY',
    union_schema_profile: 'BASELINE_WITH_RARE',
    checkpoint_strategy,
    schema_drift_profile: 'BASELINE_THEN_DRIFT',
    global_processing: 'STREAM_DEFAULT',
    route_inheritance,
    route_transform_override,
    route_protection_override,
    route_classification_override,
    route_policy_override,
    runtime_condition,
  }
}

export function unknownPoliciesFor(type: UnknownFieldType): UnknownFieldPolicy[] {
  if (type === 'NONE') return ['NONE']
  if (type === 'NORMAL') return ['PASS_THROUGH', 'DROP_FIELD', 'QUARANTINE']
  return ['PASS_THROUGH', 'DROP_FIELD', 'QUARANTINE', 'AUTO_PROTECT']
}

export function capabilityIdsForAxes(axes: CrossProductAxes): string[] {
  const ids = new Set<string>()
  const sourceCap: Record<SourceType, string> = {
    HTTP_API_POLLING: 'source.http_api_polling',
    S3_OBJECT_POLLING: 'source.s3_object_polling',
    DATABASE_QUERY: 'source.database_query_postgresql',
    REMOTE_FILE_POLLING: 'source.remote_file_polling',
    WEBHOOK_RECEIVER: 'source.webhook_receiver',
  }
  ids.add(sourceCap[axes.source_type])
  const destCap: Record<DestinationType, string> = {
    SYSLOG_UDP: 'destination.syslog_udp',
    SYSLOG_TCP: 'destination.syslog_tcp',
    SYSLOG_TLS: 'destination.syslog_tls',
    WEBHOOK_POST: 'destination.webhook_post',
  }
  ids.add(destCap[axes.destination_type])
  if (axes.field_mapping === 'ON') ids.add('processing.mapping.field_jsonpath')
  if (axes.timestamp_normalization === 'ON') ids.add('processing.enrichment.timestamp_conversion')
  if (axes.jsonata === 'ON') ids.add('processing.enrichment.jsonata')
  if (axes.regex === 'ON') ids.add('processing.mapping.full_event_regex')
  ids.add(`governance.protection.${axes.protection_action === 'mask_partial' ? 'mask' : axes.protection_action === 'drop_field' ? 'drop_field' : axes.protection_action}`)
  ids.add(`governance.delivery.${axes.delivery_behavior}`)
  ids.add('governance.schema_drift')
  if (axes.sensitive_detection_profile === 'ON') ids.add('governance.sensitive_detection')
  if (axes.dedup_strategy !== 'OFF') ids.add('runtime.dedup')
  if (axes.incremental_fetch === 'ON') ids.add('runtime.incremental_fetch')
  if (axes.route_runtime === 'ROUTE_ON') ids.add('flag.gdc_route_processing_enabled')
  ids.add('routes.architecture.one_stream_many_routes')
  if (axes.execution_surface === 'BROWSER') ids.add('test.playwright.browser_e2e')
  if (axes.fault_type !== 'NONE') ids.add('runtime.fault_injection.fixtures')
  if (axes.replay_mode !== 'NONE') ids.add('governance.replay')
  return [...ids].sort()
}
