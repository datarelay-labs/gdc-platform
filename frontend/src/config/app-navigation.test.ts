import { describe, expect, it } from 'vitest'
import { SIDEBAR_STRUCTURE, sidebarItemsForPersona, sidebarStructureForRole } from './app-navigation'

describe('sidebarStructureForRole (DATA-RELAY-UX-CHARTER)', () => {
  it('exposes work-centered primary navigation (no Governance group, no Routes leaf)', () => {
    const structure = sidebarStructureForRole(false)
    const keys = structure.flatMap((entry) =>
      entry.type === 'item' ? [entry.item.key] : entry.group.items.map((i) => i.key),
    )
    expect(keys).toEqual(['dashboard', 'connectors', 'streams', 'destinations', 'administration'])
  })

  it('does not promote Governance or Routes for governance-capable roles', () => {
    const structure = sidebarStructureForRole(true)
    const keys = structure.flatMap((entry) =>
      entry.type === 'item' ? [entry.item.key] : entry.group.items.map((i) => i.key),
    )
    expect(keys).toEqual(['dashboard', 'connectors', 'streams', 'destinations', 'administration'])
    expect(keys).not.toContain('routes')
    expect(keys).not.toContain('governance')
    expect(keys).not.toContain('governanceWorkspace')
  })

  it('exposes grouped Data Sources and Delivery sections only', () => {
    const groups = SIDEBAR_STRUCTURE.filter((entry) => entry.type === 'group').map((entry) => entry.group.id)
    expect(groups).toEqual(['dataSources', 'delivery'])
  })
})

describe('sidebarItemsForPersona M17.4', () => {
  it('hides Governance and Routes for connector persona', () => {
    const items = sidebarItemsForPersona(false)
    expect(items.map((i) => i.key)).toEqual(['dashboard', 'connectors', 'streams', 'destinations', 'administration'])
    expect(items).toHaveLength(5)
  })

  it('keeps the same simplified primary navigation for governance persona', () => {
    const items = sidebarItemsForPersona(true)
    expect(items.map((i) => i.key)).toEqual(['dashboard', 'connectors', 'streams', 'destinations', 'administration'])
    expect(items).toHaveLength(5)
  })
})
