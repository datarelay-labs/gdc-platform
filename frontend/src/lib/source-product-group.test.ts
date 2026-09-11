import { describe, expect, it } from 'vitest'
import { groupRowsBySourceProduct, resolveSourceProductLabel, worstStreamStatus } from './source-product-group'

describe('source-product-group', () => {
  it('prefers connector.product_group over name heuristic', () => {
    expect(resolveSourceProductLabel('CrowdStrike Falcon API', { product_group: 'Custom Group' })).toBe('Custom Group')
  })

  it('maps connector names to product labels when product_group absent', () => {
    expect(resolveSourceProductLabel('CrowdStrike Falcon API')).toBe('CrowdStrike')
    expect(resolveSourceProductLabel('Okta System Log')).toBe('Okta')
    expect(resolveSourceProductLabel('')).toBe('Other sources')
  })

  it('groups Office365 and AWS by product_group and inherits worst stream health', () => {
    const groups = groupRowsBySourceProduct([
      { connectorName: 'o365-a', connectorProductGroup: 'Office365', status: 'RUNNING' },
      { connectorName: 'o365-b', connectorProductGroup: 'Office365', status: 'DEGRADED' },
      { connectorName: 'aws-a', connectorProductGroup: 'AWS', status: 'RUNNING' },
    ])
    const byLabel = Object.fromEntries(groups.map((g) => [g.productLabel, g]))
    expect(byLabel.Office365?.worstStatus).toBe('DEGRADED')
    expect(byLabel.Office365?.issueCount).toBe(1)
    expect(byLabel.Office365?.rows).toHaveLength(2)
    expect(byLabel.AWS?.worstStatus).toBe('RUNNING')
    expect(byLabel.AWS?.issueCount).toBe(0)
    expect(byLabel.AWS?.rows).toHaveLength(1)
  })
})
