/** Shared types for Full E2E Lab scenarios. */

export type RouteProcessingMode = 'off' | 'on'

export type AuthKind =
  | 'no_auth'
  | 'basic'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'oauth2_client_credentials'
  | 'session_login'
  | 'jwt_refresh_token'
  | 'vendor_jwt_exchange'

/** Smoke + matrix scenario directory names under e2e/reports/<runId>/ */
export type ScenarioId = string

export type ScenarioResult = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE' | 'NOT_IMPLEMENTED' | 'SKIP'

export type LabEnv = {
  apiBaseUrl: string
  uiBaseUrl: string
  wiremockBaseUrl: string
  webhookCollectorUrl: string
  syslogCollectorApiUrl: string
  syslogHost: string
  syslogPort: number
  syslogTlsPort: number
  namePrefix: string
  /** S3 object prefix for this worker/generation (defaults to full-e2e/). */
  s3Prefix: string
  /** Collector isolation token; empty means shared/legacy collectors. */
  collectorChannel: string
  /** SFTP remote directory for this worker (defaults to /upload/full-e2e). */
  sftpDirectory: string
  routeProcessingEnabled: boolean
  requireAuth: boolean
  minioEndpoint: string
  minioAccessKey: string
  minioSecretKey: string
  minioBucket: string
  pgFixtureUrl: string
  sftpHost: string
  sftpPort: number
  sftpUser: string
  sftpPassword: string
}

export type ConnectorRef = {
  connectorId: number
  sourceId: number
  name: string
  /** WEBHOOK_RECEIVER: stable ingest key from Source.config_json */
  receiverKey?: string
  receiverPath?: string
  webhookAuthMode?: string
  webhookSharedSecret?: string
  webhookAuthHeaderName?: string
  webhookBearerToken?: string
}

export type DestinationRef = {
  destinationId: number
  name: string
  destinationType: string
}

export type StreamRef = {
  streamId: number
  name: string
  routeIds: number[]
}

export type EvidencePaths = {
  runDir: string
  scenarioDir: string
}
