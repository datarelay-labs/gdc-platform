import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildUnionSchema } from '../../utils/unionSchema'
import { attachSensitiveSuggestions } from '../../utils/unionSchemaSensitiveSuggestions'
import { UnionFieldDetailPanel } from './union-field-detail-panel'

describe('UnionFieldDetailPanel', () => {
  it('shows placeholder when no field is selected', () => {
    const schema = buildUnionSchema([{ email: 'a@test.com' }])
    render(<UnionFieldDetailPanel field={null} schema={schema} />)
    expect(screen.getByTestId('union-field-detail-panel')).toHaveTextContent('Select a field to view details')
  })

  it('shows frequency, rare, sensitive, suggested type, and sample values from backend suggestions', () => {
    const base = buildUnionSchema(
      Array.from({ length: 10 }, (_, i) =>
        i < 2
          ? { email: `u${i}@test.com`, widget: 'rare' }
          : { email: `u${i}@test.com` },
      ),
    )
    const schema = attachSensitiveSuggestions(base, [
      {
        field_path: '$.email',
        suggested_sensitive_type: 'Likely Email',
        sensitivity_class: 'pii',
        detection_method: 'field_name',
        detection_source: 'sensitive_detection_engine',
      },
    ])
    const emailField = schema.fields.find((f) => f.field_path === '$.email')
    const widgetField = schema.fields.find((f) => f.field_path === '$.widget')
    expect(emailField).toBeDefined()
    expect(widgetField).toBeDefined()

    const { rerender } = render(<UnionFieldDetailPanel field={emailField!} schema={schema} />)
    expect(screen.getByText('$.email')).toBeInTheDocument()
    expect(screen.getByTestId('union-field-detail-frequency')).toHaveTextContent('10/10')
    expect(screen.getByTestId('union-field-detail-sensitive')).toHaveTextContent('sensitive')
    expect(screen.getByTestId('union-field-detail-suggested-type')).toHaveTextContent('Likely Email')
    expect(screen.getByTestId('union-field-detail-samples').children.length).toBeLessThanOrEqual(5)

    rerender(<UnionFieldDetailPanel field={widgetField!} schema={schema} />)
    expect(screen.getByTestId('union-field-detail-frequency')).toHaveTextContent('2/10')
    expect(screen.getByTestId('union-field-detail-rare')).toHaveTextContent('rare')
    expect(screen.queryByTestId('union-field-detail-sensitive')).not.toBeInTheDocument()
    expect(screen.getByTestId('union-field-detail-suggested-type')).toHaveTextContent('—')
  })
})
