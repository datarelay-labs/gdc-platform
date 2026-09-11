import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyEditorDrawer } from './policy-editor-drawer'
import type { GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { PERSONA_STORAGE_KEY } from '../../utils/persona-mode'

const samplePolicy: GovernancePolicyEntry = {
  id: 1,
  name: 'Customer Data Protection',
  description: 'PII',
  category: 'DATA_PROTECTION',
  status: 'DRAFT',
  policy_json: {
    conditions: [{ field: 'classification', operator: 'equals', value: 'RESTRICTED' }],
    actions: [{ type: 'quarantine' }],
  },
  version: 1,
  assigned_stream_count: 1,
  assigned_stream_ids: [10],
  created_at: '2026-06-05T12:00:00Z',
  updated_at: '2026-06-05T12:00:00Z',
}

vi.mock('../../api/gdcGovernancePolicies', () => ({
  createGovernancePolicy: vi.fn(),
  updateGovernancePolicy: vi.fn(),
  fetchPolicyAssignments: vi.fn(async () => ({ policy_id: 1, assignments: [{ stream_id: 10, enabled: true }] })),
  updatePolicyAssignments: vi.fn(),
  fetchPolicyPreview: vi.fn(),
  previewPolicyJson: vi.fn(async () => ({
    policy_id: 0,
    policy_json: samplePolicy.policy_json,
    rules: [{ condition_text: 'classification = RESTRICTED', action_text: 'quarantine', combined: 'IF classification = RESTRICTED THEN quarantine' }],
    summary: 'IF classification = RESTRICTED THEN quarantine',
  })),
  previewPolicyImpact: vi.fn(async () => ({
    window: '24h',
    total_events: 100,
    matched_events: 12,
    actions: { quarantine: 12 },
    streams: [{ stream_id: 10, stream_name: 'Test Stream', total_events: 100, matched_events: 12 }],
    delta: { matched_events_change: null },
    data_available: true,
  })),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => [{ id: 10, name: 'Test Stream' }]),
}))

describe('PolicyEditorDrawer impact panel', () => {
  beforeEach(() => {
    localStorage.setItem(PERSONA_STORAGE_KEY, 'governance')
  })

  afterEach(() => {
    localStorage.removeItem(PERSONA_STORAGE_KEY)
  })

  it('renders impact panel with preview notice', async () => {
    render(
      <PolicyEditorDrawer open policy={samplePolicy} onClose={() => {}} onSaved={() => {}} />,
    )
    expect(await screen.findByTestId('policy-impact-panel')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Matched Events')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Preview only — runtime enforcement not enabled/i).length).toBeGreaterThanOrEqual(1)
  })

  it('does not offer AI Governance as a policy category', async () => {
    render(
      <PolicyEditorDrawer open policy={samplePolicy} onClose={() => {}} onSaved={() => {}} />,
    )
    const category = await screen.findByTestId('policy-editor-category')
    expect(category).not.toHaveTextContent('AI Governance')
  })

  it('shows empty impact state from API', async () => {
    const { previewPolicyImpact } = await import('../../api/gdcGovernancePolicies')
    vi.mocked(previewPolicyImpact).mockResolvedValueOnce({
      window: '24h',
      total_events: 0,
      matched_events: 0,
      actions: {},
      streams: [],
      delta: { matched_events_change: null },
      data_available: false,
    })
    render(
      <PolicyEditorDrawer open policy={samplePolicy} onClose={() => {}} onSaved={() => {}} />,
    )
    expect(await screen.findByTestId('policy-impact-empty')).toHaveTextContent('Not enough runtime data yet')
  })
})
