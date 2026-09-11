#!/usr/bin/env npx tsx
/**
 * Applicability alignment vs current Wizard persist kinds.
 *
 * MIXED_TRANSFORM / MIXED_POLICY persist at wizard deploy and must be Browser-supported.
 * Incomplete classification / protection drafts remain intent_only Deploy blockers
 * and are not MIXED_* topologies.
 *
 * Browser SUPPORTED without a live Wizard Playwright spec (or with skip) is FAIL.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_NO_FAILOVER_UI_TOPOLOGIES,
  BROWSER_SUPPORTED_TOPOLOGIES,
  deriveDependentAxes,
  evaluateApplicability,
  ROUTE_ON_TOPOLOGIES,
} from './applicability-rules.js'
import type { CrossProductAxes, RouteTopology } from './cross-product-types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const liveWizardSpec = path.join(here, 'live-wizard/live-wizard-acceptance.spec.ts')
const liveWizardHelper = path.join(here, '../framework/browser/wizard-live-acceptance.ts')

function browserAxes(topology: RouteTopology, over: Partial<CrossProductAxes> = {}): CrossProductAxes {
  const failover_mode = topology === 'FAILOVER_ROUTE' ? 'FAILOVER_ON_DESTINATION_FAILURE' : 'NONE'
  return deriveDependentAxes({
    execution_surface: 'BROWSER',
    route_runtime: 'ROUTE_ON',
    source_type: 'HTTP_API_POLLING',
    source_auth: 'no_auth',
    destination_type: 'WEBHOOK_POST',
    destination_auth_protocol: 'NONE',
    route_topology: topology,
    field_mapping: 'ON',
    timestamp_normalization: 'ON',
    jsonata: 'ON',
    regex: 'ON',
    protection_action: 'audit',
    delivery_behavior: 'continue',
    incremental_fetch: 'OFF',
    dedup_strategy: 'EVENT_ID_SKIP_DUPLICATE',
    unknown_field_type: 'NONE',
    unknown_field_policy: 'NONE',
    sensitive_detection_profile: 'OFF',
    classification_profile: 'NONE',
    fault_type: 'NONE',
    replay_mode: 'NONE',
    failover_mode,
    ...over,
  })
}

{
  assert.equal(
    BROWSER_SUPPORTED_TOPOLOGIES.has('MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE'),
    true,
    'MIXED_TRANSFORM is Browser-supported',
  )
  const axes = browserAxes('MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE')
  assert.equal(axes.route_transform_override, 'ON')
  assert.equal(axes.route_policy_override, 'OFF')
  assert.equal(evaluateApplicability(axes), null)
}

{
  assert.equal(
    BROWSER_SUPPORTED_TOPOLOGIES.has('MULTI_ROUTE_MIXED_POLICY_OVERRIDE'),
    true,
    'MIXED_POLICY is Browser-supported',
  )
  const axes = browserAxes('MULTI_ROUTE_MIXED_POLICY_OVERRIDE')
  assert.equal(axes.route_policy_override, 'ON')
  assert.equal(axes.route_transform_override, 'OFF')
  assert.equal(evaluateApplicability(axes), null)
}

{
  const axes = browserAxes('MULTI_ROUTE_MIXED_PROTECTION_OVERRIDE')
  assert.equal(axes.route_protection_override, 'ON')
  assert.equal(evaluateApplicability(axes), null)
}

{
  const axes = browserAxes('FAILOVER_ROUTE')
  assert.equal(evaluateApplicability(axes), null)
  assert.equal(BROWSER_NO_FAILOVER_UI_TOPOLOGIES.has('FAILOVER_ROUTE'), false)
  assert.equal(BROWSER_SUPPORTED_TOPOLOGIES.has('FAILOVER_ROUTE'), true)
}

{
  const apiTransform = browserAxes('MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE', {
    execution_surface: 'API_SEEDED',
  })
  assert.equal(evaluateApplicability(apiTransform), null)
  const apiPolicy = browserAxes('MULTI_ROUTE_MIXED_POLICY_OVERRIDE', {
    execution_surface: 'API_SEEDED',
  })
  assert.equal(evaluateApplicability(apiPolicy), null)
}

{
  assert.equal(
    ROUTE_ON_TOPOLOGIES.includes('MULTI_ROUTE_MIXED_CLASSIFICATION_OVERRIDE' as RouteTopology),
    false,
    'no MIXED_CLASSIFICATION topology — incomplete classification stays intent_only draft',
  )
  const mixedTransform = browserAxes('MULTI_ROUTE_MIXED_TRANSFORM_OVERRIDE')
  assert.equal(mixedTransform.route_classification_override, 'OFF')
  const mixedPolicy = browserAxes('MULTI_ROUTE_MIXED_POLICY_OVERRIDE')
  assert.equal(mixedPolicy.route_classification_override, 'OFF')
}

{
  assert.equal(fs.existsSync(liveWizardSpec), true, 'live Wizard Playwright spec must exist')
  assert.equal(fs.existsSync(liveWizardHelper), true, 'live Wizard helper must exist')
  const spec = fs.readFileSync(liveWizardSpec, 'utf-8')
  const helper = fs.readFileSync(liveWizardHelper, 'utf-8')
  assert.match(spec, /MIXED_TRANSFORM/)
  assert.match(spec, /MIXED_POLICY/)
  assert.match(spec, /CLASSIFICATION/)
  assert.match(spec, /FAILOVER/)
  assert.match(spec, /wizardLiveCreateMixedRoutes/)
  assert.match(spec, /wizardLiveCreateFailover/)
  assert.equal(
    /test\.(skip|fixme)\(/.test(spec),
    false,
    'live Wizard acceptance must not skip while MIXED_TRANSFORM/MIXED_POLICY/FAILOVER are Browser SUPPORTED',
  )
  assert.match(helper, /deploy-create-and-start/)
  assert.match(helper, /route-inherit-transform-input/)
  assert.match(helper, /route-policy-delivery-behavior/)
  assert.match(helper, /route-classification-floor/)
  assert.match(helper, /route-classification-rule-add/)
  assert.match(helper, /route-failover-enabled/)
  assert.match(helper, /route-failover-standby/)
  assert.equal(
    /createMultiRouteStream|saveDefaultFieldMappings|configureProtection/.test(spec),
    false,
    'live Wizard acceptance must not API-seed stream/transform/governance persist',
  )
}

console.log('APPLICABILITY_RULES_OK')
