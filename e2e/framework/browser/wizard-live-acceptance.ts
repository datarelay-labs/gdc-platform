/**
 * Live Playwright Wizard helpers for MIXED_TRANSFORM / MIXED_POLICY acceptance.
 * Reuses existing wizard data-testids and uiLogin/openStreamWizard.
 * Does not API-seed stream, route transform, or governance persist.
 */
import type { Page } from '@playwright/test'
import { openStreamWizard, uiLogin } from './ui-helpers.js'

export const ROUTE_B_TRANSFORM_SOURCE = '$.id'
export const ORIGINAL_MESSAGE = 'no-auth event'

const LONG = 45_000

async function clickNext(page: Page, expectedStepTestId?: string): Promise<void> {
  const next = page.getByRole('button', { name: /^Next/ })
  await next.waitFor({ state: 'visible', timeout: LONG })
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll('button')].find((el) => /^Next/.test(el.textContent || ''))
      return Boolean(btn) && !(btn as HTMLButtonElement).disabled
    },
    null,
    { timeout: LONG },
  )
  await next.click()
  if (expectedStepTestId) {
    await page.getByTestId(expectedStepTestId).waitFor({ state: 'visible', timeout: LONG })
  }
}

export async function startFreshStreamWizard(page: Page, uiBase: string): Promise<void> {
  await uiLogin(page, uiBase)
  await openStreamWizard(page, uiBase)
  const startFresh = page.getByTestId('wizard-draft-start-fresh')
  if (await startFresh.isVisible().catch(() => false)) {
    await startFresh.click()
  }
  await page.getByTestId('wizard-step-connect').waitFor({ state: 'visible', timeout: LONG })
}

export async function fillWizardConnect(
  page: Page,
  opts: { connectorId: number; connectorName: string; streamName: string; endpoint: string },
): Promise<void> {
  const select = page.getByTestId('wizard-saved-connector-select')
  await select.waitFor({ state: 'visible', timeout: LONG })
  const optionValue = String(opts.connectorId)
  const deadline = Date.now() + LONG
  while (Date.now() < deadline) {
    const hasOption = await select.locator(`option[value="${optionValue}"]`).count()
    if (hasOption) break
    await page.reload({ waitUntil: 'domcontentloaded' })
    const startFresh = page.getByTestId('wizard-draft-start-fresh')
    if (await startFresh.isVisible().catch(() => false)) {
      await startFresh.click()
    }
    await select.waitFor({ state: 'visible', timeout: LONG })
    await page.waitForTimeout(500)
  }
  if ((await select.locator(`option[value="${optionValue}"]`).count()) === 0) {
    throw new Error(`wizard connector id=${opts.connectorId} (${opts.connectorName}) not listed`)
  }
  await select.selectOption(optionValue)
  await page.getByText('Inherited from connector', { exact: false }).waitFor({ state: 'visible', timeout: LONG })
  await page.getByTestId('wizard-connect-tab-request').click()
  await page.getByTestId('wizard-connect-request').waitFor({ state: 'visible', timeout: LONG })
  const nameInput = page.getByPlaceholder('e.g. Cybereason Malop Stream')
  await nameInput.fill(opts.streamName)
  const endpointInput = page.getByText('Endpoint path *', { exact: true }).locator('..').locator('input')
  await endpointInput.fill(opts.endpoint)
}

export async function runWizardSampleAndConfirm(page: Page): Promise<void> {
  await clickNext(page, 'wizard-step-sample')
  await page.getByTestId('wizard-sample-tab-run_test').click()
  await page.getByRole('button', { name: 'Run Test' }).click()
  const success = page.getByTestId('wizard-run-test-success')
  const error = page.getByTestId('wizard-run-test-error')
  await Promise.race([
    success.waitFor({ state: 'visible', timeout: LONG }),
    error.waitFor({ state: 'visible', timeout: LONG }),
  ])
  if (await error.isVisible().catch(() => false)) {
    const detail = (await error.innerText().catch(() => '')) || 'unknown'
    throw new Error(`wizard Run Test failed: ${detail}`)
  }
  await success.waitFor({ state: 'visible', timeout: 5_000 })
  const openRecords = page.getByTestId('wizard-run-test-open-record-selection')
  if (await openRecords.count()) {
    await openRecords.click()
  } else {
    await page.getByTestId('wizard-sample-tab-record_selection').click()
  }
  await page.getByRole('button', { name: 'Advanced (Custom)' }).click()
  await page.getByPlaceholder('$.items or $.data.resultIdToElementDataMap.*').fill('$.data')
  await page.getByPlaceholder('$.eventTime').fill('$.id')
  await page.getByRole('button', { name: /Validate & Preview/ }).click()
}

export async function addWizardDestinations(page: Page, destinationNames: string[]): Promise<void> {
  await clickNext(page)
  await page.locator('#wizard-destination-library').waitFor({ state: 'visible', timeout: LONG })
  for (const name of destinationNames) {
    const search = page.locator('#wizard-destination-library input[type="search"]')
    await search.fill(name)
    const row = page.locator('#wizard-destination-library li').filter({ hasText: name })
    await row.waitFor({ state: 'visible', timeout: LONG })
    await row.getByRole('button', { name: 'Add delivery path' }).click()
    await page.getByText(name, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 })
  }
}

export async function configureSharedIdentityMapping(page: Page): Promise<void> {
  await clickNext(page, 'wizard-step-route-processing')
  const shared = page.getByTestId('route-processing-shared-transform')
  await shared.waitFor({ state: 'visible', timeout: LONG })
  await shared.getByRole('button', { name: /Auto-suggest top-level fields/ }).click()
  await shared.getByLabel('Source JSONPath').first().waitFor({ state: 'visible', timeout: LONG })
}

export async function selectRouteByDestinationName(page: Page, destinationName: string): Promise<void> {
  const list = page.getByTestId('route-processing-list')
  await list.getByText(destinationName, { exact: false }).first().click()
  await page.getByTestId('route-processing-detail-panel').waitFor({ state: 'visible', timeout: LONG })
}

export async function configureRouteBTransformOverride(page: Page, destBName: string): Promise<void> {
  await selectRouteByDestinationName(page, destBName)
  await page.getByTestId('route-detail-tab-transform').click()
  const inherit = page.getByTestId('route-inherit-transform-input')
  await inherit.waitFor({ state: 'visible', timeout: LONG })
  if (await inherit.isChecked()) {
    await inherit.uncheck()
  }
  await page.getByTestId('route-detail-transform').getByLabel('Source JSONPath').first().waitFor({
    state: 'visible',
    timeout: LONG,
  })
  const sources = page.getByTestId('route-detail-transform').getByLabel('Source JSONPath')
  const count = await sources.count()
  let found = false
  for (let i = 0; i < count; i += 1) {
    const value = await sources.nth(i).inputValue()
    if (value === '$.message' || value.endsWith('.message')) {
      await sources.nth(i).fill(ROUTE_B_TRANSFORM_SOURCE)
      found = true
      break
    }
  }
  if (!found) {
    throw new Error('Route B transform override: shared mapping did not include $.message')
  }
}

export async function configureRouteBClassificationOverride(page: Page, destBName: string): Promise<void> {
  await selectRouteByDestinationName(page, destBName)
  await page.getByTestId('route-detail-tab-classification').click()
  const inherit = page.getByTestId('route-inherit-classification-input')
  await inherit.waitFor({ state: 'visible', timeout: LONG })
  if (await inherit.isChecked()) {
    await inherit.uncheck()
  }
  await page.getByTestId('route-classification-floor').waitFor({ state: 'visible', timeout: LONG })
  await page.getByTestId('route-classification-floor').selectOption('CONFIDENTIAL')
  await page.getByTestId('route-classification-rule-add').click()
  await page.getByTestId('route-classification-rule-class').first().selectOption('pii')
  await page.getByTestId('route-classification-rule-level').first().selectOption('CONFIDENTIAL')
}

export async function configureRouteBPolicyBlock(page: Page, destBName: string): Promise<void> {
  await selectRouteByDestinationName(page, destBName)
  await page.getByTestId('route-detail-tab-policy').click()
  const inherit = page.getByTestId('route-inherit-policy-input')
  await inherit.waitFor({ state: 'visible', timeout: LONG })
  if (await inherit.isChecked()) {
    await inherit.uncheck()
  }
  await page.getByTestId('route-policy-override-section').waitFor({ state: 'visible', timeout: LONG })
  await page.getByTestId('route-policy-delivery-behavior').selectOption('block')
}

export async function goToDeployAndAssertPersistKind(
  page: Page,
  persistKind: 'route_transform' | 'governance' | 'route_classification',
): Promise<void> {
  await clickNext(page, 'wizard-step-deploy')
  await page.getByTestId('deploy-route-processing-summary').waitFor({ state: 'visible', timeout: LONG })
  const expected =
    persistKind === 'route_transform'
      ? /Persisted through route transform/i
      : persistKind === 'route_classification'
        ? /Persisted through route classification/i
        : /Persisted through governance rules/i
  await page.getByTestId('deploy-route-override-list').getByText(expected).first().waitFor({
    state: 'visible',
    timeout: LONG,
  })
}

export async function createAndStartFromDeploy(page: Page, lookupStreamId: () => Promise<number | null>): Promise<number> {
  const create = page.getByTestId('deploy-create-and-start')
  await create.waitFor({ state: 'visible', timeout: LONG })
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="deploy-create-and-start"]') as HTMLButtonElement | null
      return Boolean(btn) && !btn.disabled
    },
    null,
    { timeout: LONG },
  )
  await create.click()
  await page.getByTestId('deploy-created-panel').waitFor({ state: 'visible', timeout: LONG })
  const idText = await page.getByTestId('deploy-created-panel').locator('.font-mono').first().textContent()
  const fromDisplay = String(idText || '').match(/STR-\d+-(\d+)/)
  if (fromDisplay) {
    const parsed = Number(fromDisplay[1])
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const lookedUp = await lookupStreamId()
  if (lookedUp != null) return lookedUp
  throw new Error(`wizard deploy did not expose stream id: ${idText}`)
}

export async function configureRouteFailover(
  page: Page,
  destPrimaryName: string,
  standbyDestinationId: number,
): Promise<void> {
  await selectRouteByDestinationName(page, destPrimaryName)
  await page.getByTestId('route-detail-tab-delivery').click()
  await page.getByTestId('route-failover-configuration').waitFor({ state: 'visible', timeout: LONG })
  const enabled = page.getByTestId('route-failover-enabled')
  if (!(await enabled.isChecked())) {
    await enabled.check()
  }
  await page.getByTestId('route-failover-standby').selectOption(String(standbyDestinationId))
}

export async function wizardLiveCreateFailover(
  page: Page,
  uiBase: string,
  opts: {
    connectorId: number
    connectorName: string
    streamName: string
    endpoint: string
    primaryDestName: string
    standbyDestinationId: number
    lookupStreamId: () => Promise<number | null>
  },
): Promise<number> {
  await startFreshStreamWizard(page, uiBase)
  await fillWizardConnect(page, {
    connectorId: opts.connectorId,
    connectorName: opts.connectorName,
    streamName: opts.streamName,
    endpoint: opts.endpoint,
  })
  await runWizardSampleAndConfirm(page)
  await addWizardDestinations(page, [opts.primaryDestName])
  await configureSharedIdentityMapping(page)
  await configureRouteFailover(page, opts.primaryDestName, opts.standbyDestinationId)
  await clickNext(page, 'wizard-step-deploy')
  await page.getByTestId('deploy-route-processing-summary').waitFor({ state: 'visible', timeout: LONG })
  return createAndStartFromDeploy(page, opts.lookupStreamId)
}

export async function wizardLiveCreateMixedRoutes(
  page: Page,
  uiBase: string,
  opts: {
    connectorId: number
    connectorName: string
    streamName: string
    endpoint: string
    destAName: string
    destBName: string
    mode: 'transform' | 'policy' | 'classification'
    lookupStreamId: () => Promise<number | null>
  },
): Promise<number> {
  await startFreshStreamWizard(page, uiBase)
  await fillWizardConnect(page, {
    connectorId: opts.connectorId,
    connectorName: opts.connectorName,
    streamName: opts.streamName,
    endpoint: opts.endpoint,
  })
  await runWizardSampleAndConfirm(page)
  await addWizardDestinations(page, [opts.destAName, opts.destBName])
  await configureSharedIdentityMapping(page)
  if (opts.mode === 'transform') {
    await configureRouteBTransformOverride(page, opts.destBName)
    await goToDeployAndAssertPersistKind(page, 'route_transform')
  } else if (opts.mode === 'classification') {
    await configureRouteBClassificationOverride(page, opts.destBName)
    await goToDeployAndAssertPersistKind(page, 'route_classification')
  } else {
    await configureRouteBPolicyBlock(page, opts.destBName)
    await goToDeployAndAssertPersistKind(page, 'governance')
  }
  return createAndStartFromDeploy(page, opts.lookupStreamId)
}
