import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sidebarItemsForRole } from '../../config/app-navigation'
import {
  canActivatePolicy,
  canApprovePolicy,
  canEditPolicy,
  canExecuteReplay,
  canReleaseQuarantine,
  canSubmitApproval,
  canViewAudit,
  canViewGovernance,
  canViewGovernanceWorkspace,
  clearTestSession,
  persistTestSession,
} from '../../lib/governance-rbac'
import { PolicyCatalogPage } from './policy-catalog-page'
import { GovernanceShell } from './governance-shell'

describe('governance RBAC (M20)', () => {
  afterEach(() => {
    clearTestSession()
  })

  it('does not expose Governance as primary sidebar for VIEWER', () => {
    persistTestSession('VIEWER')
    expect(canViewGovernanceWorkspace()).toBe(false)
    const items = sidebarItemsForRole(canViewGovernanceWorkspace())
    expect(items.some((i) => i.key === 'governance' || i.key === 'governanceWorkspace')).toBe(false)
  })

  it('does not expose Governance as primary sidebar for GOVERNANCE_OPERATOR (ops via deep link)', () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    expect(canViewGovernance()).toBe(true)
    const items = sidebarItemsForRole(canViewGovernance())
    expect(items.some((i) => i.key === 'governance' || i.key === 'governanceWorkspace')).toBe(false)
    expect(items.map((i) => i.key)).toEqual(['dashboard', 'connectors', 'streams', 'destinations', 'administration'])
  })

  it('CONNECTOR_OPERATOR can view but not edit policies', () => {
    persistTestSession('CONNECTOR_OPERATOR')
    expect(canViewGovernance()).toBe(true)
    expect(canEditPolicy()).toBe(false)
    expect(canSubmitApproval()).toBe(false)
  })

  it('GOVERNANCE_OPERATOR can edit and submit', () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    expect(canEditPolicy()).toBe(true)
    expect(canSubmitApproval()).toBe(true)
    expect(canActivatePolicy()).toBe(false)
    expect(canReleaseQuarantine()).toBe(true)
    expect(canExecuteReplay()).toBe(true)
  })

  it('GOVERNANCE_REVIEWER can approve but not activate', () => {
    persistTestSession('GOVERNANCE_REVIEWER')
    expect(canApprovePolicy()).toBe(true)
    expect(canActivatePolicy()).toBe(false)
    expect(canEditPolicy()).toBe(false)
  })

  it('GOVERNANCE_APPROVER can activate', () => {
    persistTestSession('GOVERNANCE_APPROVER')
    expect(canActivatePolicy()).toBe(true)
    expect(canEditPolicy()).toBe(false)
  })

  it('GOVERNANCE_AUDITOR is read-only', () => {
    persistTestSession('GOVERNANCE_AUDITOR')
    expect(canViewAudit()).toBe(true)
    expect(canEditPolicy()).toBe(false)
    expect(canReleaseQuarantine()).toBe(false)
  })

  it('shows read-only banner for CONNECTOR_OPERATOR on policy catalog', () => {
    persistTestSession('CONNECTOR_OPERATOR')
    render(<PolicyCatalogPage />)
    expect(screen.getByText(/Governance Operator role/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new policy/i })).not.toBeInTheDocument()
  })

  it('allows VIEWER into governance shell for dashboard read-only', () => {
    persistTestSession('VIEWER')
    render(
      <MemoryRouter initialEntries={['/governance']}>
        <Routes>
          <Route path="/governance" element={<GovernanceShell />}>
            <Route index element={<div data-testid="governance-child">child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('governance-shell')).toBeInTheDocument()
    expect(screen.getByTestId('governance-child')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-unauthorized')).not.toBeInTheDocument()
  })

  it('ADMINISTRATOR has full governance capabilities', () => {
    persistTestSession('ADMINISTRATOR')
    expect(canViewGovernance()).toBe(true)
    expect(canEditPolicy()).toBe(true)
    expect(canActivatePolicy()).toBe(true)
    expect(canViewAudit()).toBe(true)
  })
})
