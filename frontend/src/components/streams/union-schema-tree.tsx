import { ChevronDown, ChevronRight, Minus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { WizardEnrichmentRule } from './wizard/enrichment-rules-model'
import { cn } from '../../lib/utils'
import {
  buildGeneratedFieldTreeNodes,
  GENERATED_FIELD_FREQUENCY_LABEL,
  type GeneratedFieldTreeNode,
} from '../../utils/generatedFieldsTree'
import { isUnionFieldSensitive } from '../../utils/unionSchemaFieldDisplay'
import {
  formatUnionOccurrence,
  isRareUnionField,
  type UnionSchema,
  type UnionSchemaField,
  unionSchemaFieldMap,
} from '../../utils/unionSchema'

export type UnionSchemaTreeProps = {
  schema: UnionSchema
  search: string
  onPickPath: (jsonPath: string) => void
  activeHighlightPath?: string | null
  selectedPath?: string | null
  onSelectPath?: (jsonPath: string) => void
  expandStrategy?: 'smart' | 'all' | 'minimal'
  generatedRules?: readonly WizardEnrichmentRule[]
}

type SchemaTreeNode = {
  label: string
  path: string
  field: UnionSchemaField | null
  children: SchemaTreeNode[]
}

function matchesSearch(text: string, q: string): boolean {
  if (!q.trim()) return true
  return text.toLowerCase().includes(q.trim().toLowerCase())
}

function pathSegmentsAfterRoot(fieldPath: string): string[] {
  const trimmed = fieldPath.trim()
  if (!trimmed.startsWith('$.')) return []
  return trimmed
    .slice(2)
    .split('.')
    .map((seg) => seg.replace(/\[\d+\]/g, '[]'))
    .filter(Boolean)
}

function buildSchemaTree(schema: UnionSchema): SchemaTreeNode[] {
  const fieldMap = unionSchemaFieldMap(schema)
  const roots: SchemaTreeNode[] = []

  const findOrCreate = (nodes: SchemaTreeNode[], label: string, path: string): SchemaTreeNode => {
    let node = nodes.find((n) => n.label === label && n.path === path)
    if (!node) {
      node = { label, path, field: fieldMap.get(path) ?? null, children: [] }
      nodes.push(node)
    }
    return node
  }

  for (const field of schema.fields) {
    const segments = pathSegmentsAfterRoot(field.field_path)
    if (segments.length === 0) continue
    let nodes = roots
    let path = '$'
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      path = path === '$' ? `$.${seg}` : `${path}.${seg}`
      const node = findOrCreate(nodes, seg, path)
      if (i === segments.length - 1) {
        node.field = field
      }
      nodes = node.children
    }
  }

  const sortNodes = (nodes: SchemaTreeNode[]): SchemaTreeNode[] =>
    [...nodes]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((n) => ({ ...n, children: sortNodes(n.children) }))

  return sortNodes(roots)
}

function subtreeMatches(node: SchemaTreeNode, q: string): boolean {
  if (!q.trim()) return true
  const field = node.field
  const haystack = [
    node.label,
    node.path,
    field?.field_type ?? '',
    field ? formatUnionOccurrence(field, { total_events: 1, fields: [field] }) : '',
    ...(field?.sample_values ?? []).map((v) => JSON.stringify(v)),
  ].join(' ')
  if (matchesSearch(haystack, q)) return true
  return node.children.some((child) => subtreeMatches(child, q))
}

function generatedNodeMatches(node: GeneratedFieldTreeNode, q: string): boolean {
  if (!q.trim()) return true
  const haystack = [
    node.label,
    node.path,
    node.field.field_type,
    GENERATED_FIELD_FREQUENCY_LABEL,
    ...(node.field.sample_values ?? []).map((v) => JSON.stringify(v)),
  ].join(' ')
  return matchesSearch(haystack, q)
}

function initialExpanded(depth: number, strategy: UnionSchemaTreeProps['expandStrategy']): boolean {
  if (strategy === 'all') return true
  if (strategy === 'minimal') return false
  return depth < 2
}

function isBranchActive(nodePath: string, needle: string | null | undefined): boolean {
  if (!needle) return false
  if (nodePath === needle) return true
  if (needle === '$') return nodePath === '$'
  return needle.startsWith(`${nodePath}.`) || needle.startsWith(`${nodePath}[`)
}

function SchemaTreeNodeRow({
  node,
  schema,
  depth,
  search,
  onPickPath,
  activeHighlightPath,
  selectedPath,
  onSelectPath,
  expandStrategy,
}: {
  node: SchemaTreeNode
  schema: UnionSchema
  depth: number
  search: string
  onPickPath: (jsonPath: string) => void
  activeHighlightPath?: string | null
  selectedPath?: string | null
  onSelectPath?: (jsonPath: string) => void
  expandStrategy: UnionSchemaTreeProps['expandStrategy']
}) {
  const [expanded, setExpanded] = useState(() => initialExpanded(depth, expandStrategy))
  const hasChildren = node.children.length > 0
  const field = node.field
  const rare = field ? isRareUnionField(field, schema) : false
  const showSensitive = field ? isUnionFieldSensitive(field) : false

  if (!subtreeMatches(node, search)) return null

  const flashActive = isBranchActive(node.path, activeHighlightPath ?? null)
  const selected = selectedPath === node.path
  const active = flashActive || selected

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-100/90 dark:hover:bg-gdc-rowHover',
          active && 'bg-violet-500/10 ring-1 ring-violet-400/40',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-300">
            <Minus className="h-2.5 w-2.5" />
          </span>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            onSelectPath?.(node.path)
            onPickPath(node.path)
          }}
          title={node.path}
          aria-pressed={selected}
        >
          <span className="font-semibold text-slate-800 dark:text-slate-100">{node.label}</span>
          {field ? (
            <span className="ml-2 tabular-nums text-[10px] text-slate-500 dark:text-gdc-muted">
              {formatUnionOccurrence(field, schema)}
            </span>
          ) : null}
          {field ? (
            <span className="ml-1 text-[9px] text-slate-400 dark:text-gdc-muted">{field.field_type}</span>
          ) : null}
        </button>
        {rare ? (
          <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold text-amber-800 dark:text-amber-200">
            rare
          </span>
        ) : null}
        {showSensitive ? (
          <span className="rounded bg-violet-500/15 px-1 text-[9px] font-bold text-violet-800 dark:text-violet-200">
            sensitive
          </span>
        ) : null}
      </div>
      {field && field.sample_values.length > 0 && expanded ? (
        <ul className="ml-6 list-none space-y-0.5 pb-1 text-[9px] text-slate-500 dark:text-gdc-muted">
          {field.sample_values.map((sample, idx) => (
            <li key={`${node.path}-sample-${idx}`} className="truncate font-mono">
              sample: {JSON.stringify(sample)}
            </li>
          ))}
        </ul>
      ) : null}
      {hasChildren && expanded ? (
        <div className="ml-3 border-l border-slate-200/80 pl-1 dark:border-gdc-border">
          {node.children.map((child) => (
            <SchemaTreeNodeRow
              key={child.path}
              node={child}
              schema={schema}
              depth={depth + 1}
              search={search}
              onPickPath={onPickPath}
              activeHighlightPath={activeHighlightPath}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              expandStrategy={expandStrategy}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function GeneratedFieldNodeRow({
  node,
  search,
  selectedPath,
  onSelectPath,
}: {
  node: GeneratedFieldTreeNode
  search: string
  selectedPath?: string | null
  onSelectPath?: (jsonPath: string) => void
}) {
  const field = node.field
  const showSensitive = isUnionFieldSensitive(field)
  const selected = selectedPath === node.path

  if (!generatedNodeMatches(node, search)) return null

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-100/90 dark:hover:bg-gdc-rowHover',
          selected && 'bg-violet-500/10 ring-1 ring-violet-400/40',
        )}
      >
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-300">
          <Minus className="h-2.5 w-2.5" />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => onSelectPath?.(node.path)}
          title={node.path}
          aria-pressed={selected}
          data-testid={`generated-field-node-${node.label}`}
        >
          <span className="font-semibold text-slate-800 dark:text-slate-100">{node.label}</span>
          <span className="ml-2 text-[10px] text-slate-500 dark:text-gdc-muted">{GENERATED_FIELD_FREQUENCY_LABEL}</span>
          <span className="ml-1 text-[9px] text-slate-400 dark:text-gdc-muted">{field.field_type}</span>
        </button>
        {showSensitive ? (
          <span className="rounded bg-violet-500/15 px-1 text-[9px] font-bold text-violet-800 dark:text-violet-200">
            sensitive
          </span>
        ) : null}
      </div>
    </div>
  )
}

function GeneratedFieldsGroup({
  nodes,
  search,
  selectedPath,
  onSelectPath,
  expandStrategy,
}: {
  nodes: GeneratedFieldTreeNode[]
  search: string
  selectedPath?: string | null
  onSelectPath?: (jsonPath: string) => void
  expandStrategy: UnionSchemaTreeProps['expandStrategy']
}) {
  const [expanded, setExpanded] = useState(() => expandStrategy === 'all' || expandStrategy === 'smart')
  const visibleNodes = nodes.filter((node) => generatedNodeMatches(node, search))
  if (visibleNodes.length === 0) return null

  return (
    <div className="mt-2 border-t border-slate-200/70 pt-2 dark:border-gdc-border" data-testid="generated-fields-group">
      <div className="group flex items-center gap-1 rounded px-1 py-0.5">
        <button
          type="button"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse Generated Fields' : 'Expand Generated Fields'}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <span className="font-semibold text-slate-700 dark:text-slate-200">Generated Fields</span>
      </div>
      {expanded ? (
        <div className="ml-3 border-l border-slate-200/80 pl-1 dark:border-gdc-border">
          {nodes.map((node) => (
            <GeneratedFieldNodeRow
              key={node.path}
              node={node}
              search={search}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function UnionSchemaTree({
  schema,
  search,
  onPickPath,
  activeHighlightPath = null,
  selectedPath = null,
  onSelectPath,
  expandStrategy = 'smart',
  generatedRules = [],
}: UnionSchemaTreeProps) {
  const roots = useMemo(() => buildSchemaTree(schema), [schema])
  const generatedNodes = useMemo(() => buildGeneratedFieldTreeNodes(generatedRules), [generatedRules])
  const hasUnionFields = roots.length > 0
  const hasGeneratedFields = generatedNodes.length > 0

  return (
    <div className="font-mono text-[11px] leading-snug" data-testid="union-schema-tree">
      {!hasUnionFields && !hasGeneratedFields ? (
        <p className="px-1 py-2 text-[11px] italic text-slate-500">No union schema fields.</p>
      ) : (
        <>
          {roots.map((node) => (
            <SchemaTreeNodeRow
              key={node.path}
              node={node}
              schema={schema}
              depth={0}
              search={search}
              onPickPath={onPickPath}
              activeHighlightPath={activeHighlightPath}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              expandStrategy={expandStrategy}
            />
          ))}
          <GeneratedFieldsGroup
            nodes={generatedNodes}
            search={search}
            selectedPath={selectedPath}
            onSelectPath={onSelectPath}
            expandStrategy={expandStrategy}
          />
        </>
      )}
    </div>
  )
}
