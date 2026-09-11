import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcDynamicRouting from '../../api/gdcDynamicRouting'
import { DynamicRoutingPanel } from './dynamic-routing-panel'

describe('DynamicRoutingPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcDynamicRouting, 'fetchStreamDynamicRoutingSummary').mockResolvedValue({
      stream_id: 10,
      total_dynamic_routes: 1,
      matched_dynamic_routes: 1,
      dynamic_deliveries: 0,
      last_evaluated_at: null,
    })
    vi.spyOn(gdcDynamicRouting, 'fetchStreamDynamicRoutes').mockResolvedValue({
      stream_id: 10,
      route_count: 1,
      routes: [
        {
          id: 7,
          stream_id: 10,
          name: 'Secret to A',
          enabled: true,
          condition_json: { sensitivity_class: 'secret' },
          route_id: 42,
          route_name: 'Route #42',
          destination_id: 5,
          destination_name: 'Splunk',
          created_at: '2026-08-16T00:00:00Z',
          updated_at: '2026-08-16T00:00:00Z',
        },
      ],
    })
  })

  it('shows route name then destination name', async () => {
    render(<DynamicRoutingPanel streamId={10} />)
    expect(await screen.findByTestId('dynamic-route-row-7')).toHaveTextContent('Route #42')
    expect(screen.getByTestId('dynamic-route-row-7')).toHaveTextContent('Splunk')
    expect(screen.getByTestId('dynamic-route-row-7')).toHaveTextContent('→')
  })
})
