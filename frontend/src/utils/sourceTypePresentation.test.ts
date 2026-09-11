import { describe, expect, it } from 'vitest'
import { WIZARD_STEPS } from '../components/streams/wizard/wizard-state'
import {
  classifyStandaloneStreamSourceType,
  firstNonEmptySourceType,
  GDC_STREAM_SOURCE_TYPES,
  normalizeGdcStreamSourceType,
  resolveSourceTypePresentation,
  resolveStreamSourceTestPageIntro,
  resolveStreamSourceTestShellTitle,
  SOURCE_TEST_SHELL_NEUTRAL_TITLE,
  wizardStepsWithSourcePresentation,
} from './sourceTypePresentation'

describe('normalizeGdcStreamSourceType', () => {
  it('does not include AI_PROXY in wizard source types', () => {
    expect(GDC_STREAM_SOURCE_TYPES).not.toContain('AI_PROXY')
    expect(GDC_STREAM_SOURCE_TYPES).not.toContain('AI_PROXY_RECEIVER')
  })
  it('maps known values', () => {
    expect(normalizeGdcStreamSourceType('REMOTE_FILE_POLLING')).toBe('REMOTE_FILE_POLLING')
    expect(normalizeGdcStreamSourceType('REMOTE_FILE')).toBe('REMOTE_FILE_POLLING')
    expect(normalizeGdcStreamSourceType('s3_object_polling')).toBe('S3_OBJECT_POLLING')
    expect(normalizeGdcStreamSourceType('s3')).toBe('S3_OBJECT_POLLING')
    expect(normalizeGdcStreamSourceType('database_query')).toBe('DATABASE_QUERY')
    expect(normalizeGdcStreamSourceType('webhook')).toBe('WEBHOOK_RECEIVER')
  })

  it('defaults unknown to HTTP', () => {
    expect(normalizeGdcStreamSourceType('')).toBe('HTTP_API_POLLING')
    expect(normalizeGdcStreamSourceType('KAFKA')).toBe('HTTP_API_POLLING')
  })
})

describe('classifyStandaloneStreamSourceType', () => {
  it('does not fall AI Proxy or unknown types back to HTTP', () => {
    expect(classifyStandaloneStreamSourceType('AI_PROXY_RECEIVER')).toBe('AI_PROXY_RECEIVER')
    expect(classifyStandaloneStreamSourceType('KAFKA')).toBe('UNSUPPORTED')
    expect(classifyStandaloneStreamSourceType('')).toBe('UNSUPPORTED')
  })
})

describe('firstNonEmptySourceType', () => {
  it('skips empty mapping source_type so stream.stream_type is used', () => {
    expect(firstNonEmptySourceType('', null, 'S3_OBJECT_POLLING')).toBe('S3_OBJECT_POLLING')
    expect(firstNonEmptySourceType('  ', 'DATABASE_QUERY')).toBe('DATABASE_QUERY')
    expect(firstNonEmptySourceType(undefined, undefined, 'REMOTE_FILE_POLLING')).toBe('REMOTE_FILE_POLLING')
    expect(firstNonEmptySourceType('', null, undefined)).toBeNull()
  })
})

describe('resolveSourceTypePresentation', () => {
  it('returns distinct API test labels per source', () => {
    expect(resolveSourceTypePresentation('HTTP_API_POLLING').workflow.apiTestShortLabel).toBe('API Test')
    expect(resolveSourceTypePresentation('REMOTE_FILE_POLLING').workflow.apiTestShortLabel).toBe('Remote probe')
    expect(resolveSourceTypePresentation('DATABASE_QUERY').workflow.apiTestShortLabel).toBe('Query test')
    expect(resolveSourceTypePresentation('S3_OBJECT_POLLING').workflow.apiTestShortLabel).toBe('Object preview')
    expect(resolveSourceTypePresentation('WEBHOOK_RECEIVER').workflow.apiTestShortLabel).toBe('Payload preview')
  })

  it('hides HTTP-only summary rows for remote', () => {
    expect(resolveSourceTypePresentation('HTTP_API_POLLING').summary.showHttpEndpointRows).toBe(true)
    expect(resolveSourceTypePresentation('REMOTE_FILE_POLLING').summary.showHttpEndpointRows).toBe(false)
  })

  it('marks webhook as push ingest without checkpoint observability', () => {
    const wh = resolveSourceTypePresentation('WEBHOOK_RECEIVER')
    expect(wh.runtime.usesPushIngest).toBe(true)
    expect(wh.runtime.showCheckpointObservability).toBe(false)
    expect(resolveSourceTypePresentation('HTTP_API_POLLING').runtime.showCheckpointObservability).toBe(true)
  })

  it('exposes app shell source-test titles per source', () => {
    expect(resolveSourceTypePresentation('HTTP_API_POLLING').appShellSourceTestTitle).toBe('API Test & Preview')
    expect(resolveSourceTypePresentation('REMOTE_FILE_POLLING').appShellSourceTestTitle).toBe('Remote Probe & Preview')
    expect(resolveSourceTypePresentation('DATABASE_QUERY').appShellSourceTestTitle).toBe('Query Test & Preview')
    expect(resolveSourceTypePresentation('S3_OBJECT_POLLING').appShellSourceTestTitle).toBe('Object Preview')
    expect(resolveSourceTypePresentation('WEBHOOK_RECEIVER').appShellSourceTestTitle).toBe('Webhook Payload Preview')
  })
})

describe('wizardStepsWithSourcePresentation', () => {
  it('enriches connect and sample subtitles for remote file polling', () => {
    const steps = wizardStepsWithSourcePresentation(WIZARD_STEPS, 'REMOTE_FILE_POLLING')
    expect(steps.map((s) => s.key)).toEqual([
      'connect',
      'sample',
      'destinations',
      'route_processing',
      'deploy',
    ])
    expect(steps.find((s) => s.key === 'connect')?.subtitle).toContain('Remote files')
    expect(steps.find((s) => s.key === 'sample')?.subtitle).toContain('Remote probe')
  })

  it('enriches connect and sample subtitles for HTTP_API_POLLING', () => {
    const steps = wizardStepsWithSourcePresentation(WIZARD_STEPS, 'HTTP_API_POLLING')
    expect(steps.find((s) => s.key === 'connect')?.subtitle).toContain('HTTP Request')
    expect(steps.find((s) => s.key === 'sample')?.subtitle).toContain('API Test')
  })
})

describe('resolveStreamSourceTestShellTitle', () => {
  it('uses slug hints for fixture stream ids', () => {
    expect(resolveStreamSourceTestShellTitle('malop-api', null)).toBe('API Test & Preview')
    expect(resolveStreamSourceTestShellTitle('fixture-remote-stream', null)).toBe('Remote Probe & Preview')
    expect(resolveStreamSourceTestShellTitle('fixture-db-stream', null)).toBe('Query Test & Preview')
    expect(resolveStreamSourceTestShellTitle('fixture-s3-stream', null)).toBe('Object Preview')
  })

  it('prefers API source type over slug map', () => {
    expect(resolveStreamSourceTestShellTitle('malop-api', 'S3_OBJECT_POLLING')).toBe('Object Preview')
  })

  it('falls back to neutral title when unknown', () => {
    expect(resolveStreamSourceTestShellTitle('unknown-stream-slug', null)).toBe(SOURCE_TEST_SHELL_NEUTRAL_TITLE)
    expect(resolveStreamSourceTestShellTitle(undefined, null)).toBe(SOURCE_TEST_SHELL_NEUTRAL_TITLE)
  })

  it('uses neutral title for AI Proxy instead of HTTP labels', () => {
    expect(resolveStreamSourceTestShellTitle('1', 'AI_PROXY_RECEIVER')).toBe(SOURCE_TEST_SHELL_NEUTRAL_TITLE)
  })
})

describe('resolveStreamSourceTestPageIntro', () => {
  it('returns neutral intro when no API type and no slug hint', () => {
    expect(resolveStreamSourceTestPageIntro('no-hint-slug', null)).toMatch(/numeric stream id/i)
  })
})
