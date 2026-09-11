import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { streamMappingPath } from '../../config/nav-paths'
import { countLeafKeys, formatBytes, resolveJsonPath } from './stream-api-test-json-utils'
import { StreamWorkflowSummaryStrip } from './stream-workflow-checklist'
import { computeStreamWorkflow } from '../../utils/streamWorkflow'
import {
  STREAM_ID_SHELL_SOURCE_TYPE_HINT,
  firstNonEmptySourceType,
  resolveStreamSourceTestPageIntro,
  resolveStreamSourceTestShellTitle,
  type StandaloneStreamSourceKind,
} from '../../utils/sourceTypePresentation'
import { fetchStreamById } from '../../api/gdcStreams'
import { fetchStreamMappingUiConfig } from '../../api/gdcRuntime'
import { fetchConnectorById } from '../../api/gdcConnectors'
import type { MappingUIConfigResponse, StreamRead } from '../../api/types/gdcApi'
import {
  runExtractionValidate,
  type ExtractionValidateResponse,
  type HttpApiTestResponse,
} from '../../api/gdcRuntimePreview'
import {
  buildWebhookStandaloneSampleResult,
  resolveStandaloneStreamSourceKind,
  runStandaloneStreamSourceTest,
  standaloneConnectionStatusLabel,
  standaloneSampleStatusLabel,
  type StandaloneConnectionStatus,
  type StandaloneSampleStatus,
} from '../../utils/standaloneStreamSourceTest'

const WIZARD_STEPS = [
  { key: 'connector', title: 'Select Connector', subtitle: 'Choose a connector' },
  { key: 'endpoint', title: 'Configure Endpoint', subtitle: 'Define API endpoint' },
  { key: 'polling', title: 'Configure Polling', subtitle: 'Set schedule & pagination' },
  { key: 'test', title: 'Test Connection', subtitle: 'Verify & preview data' },
  { key: 'review', title: 'Review & Create', subtitle: 'Confirm and create' },
] as const

const ACTIVE_WIZARD_STEP = 3

type ResponseTab = 'json' | 'raw' | 'headers'
type ExtractionMode = 'basic' | 'advanced'

const MAX_SYNTAX_HIGHLIGHT_CHARS = 48_000

function JsonCodeView({ text }: { text: string }) {
  const useColors = text.length <= MAX_SYNTAX_HIGHLIGHT_CHARS
  return (
    <pre
      className="max-h-[min(280px,42vh)] overflow-auto rounded-lg border border-slate-700/80 bg-[#1e1e2e] p-3 font-mono text-[11px] leading-relaxed text-slate-100 subpixel-antialiased dark:bg-[#151520]"
      tabIndex={0}
    >
      <code className="text-[11px]">{useColors ? highlightJson(text) : text}</code>
    </pre>
  )
}

/** Lightweight syntax tinting for demo (no parser deps). */
function highlightJson(json: string): ReactNode {
  const lines = json.split('\n')
  return lines.map((line, li) => (
    <span key={li} className="block">
      {tokenizeJsonLine(line).map((t, i) => (
        <span key={i} className={t.cls}>
          {t.s}
        </span>
      ))}
    </span>
  ))
}

function tokenizeJsonLine(line: string): { s: string; cls: string }[] {
  const out: { s: string; cls: string }[] = []
  let i = 0
  const push = (s: string, cls: string) => out.push({ s, cls })
  const defaultCls = 'text-slate-200'
  const keyCls = 'text-sky-300'
  const strCls = 'text-emerald-300'
  const numCls = 'text-amber-300'
  const boolCls = 'text-violet-300'
  while (i < line.length) {
    const c = line[i]
    if (c === '"') {
      const end = line.indexOf('"', i + 1)
      const chunk = end === -1 ? line.slice(i) : line.slice(i, end + 1)
      const after = line.slice(i + chunk.length).trimStart()
      const isKey = after.startsWith(':')
      push(chunk, isKey ? keyCls : strCls)
      i += chunk.length
      continue
    }
    if (/[-\d.]/.test(c)) {
      let j = i
      while (j < line.length && /[-\d.eE+]/.test(line[j])) j += 1
      push(line.slice(i, j), numCls)
      i = j
      continue
    }
    if (line.slice(i, i + 4) === 'true' || line.slice(i, i + 5) === 'false') {
      const len = line[i] === 't' ? 4 : 5
      push(line.slice(i, i + len), boolCls)
      i += len
      continue
    }
    if (line.slice(i, i + 4) === 'null') {
      push('null', boolCls)
      i += 4
      continue
    }
    push(c, defaultCls)
    i += 1
  }
  return out
}

type TreeProps = {
  value: unknown
  path: string
  depth: number
  search: string
  expanded: Set<string>
  selectedPath: string
  onToggle: (path: string) => void
  onSelect: (path: string, value: unknown) => void
}

function JsonTree({ value, path, depth, search, expanded, selectedPath, onToggle, onSelect }: TreeProps) {
  const q = search.trim().toLowerCase()

  const matches = (label: string, childPaths: string[]) => {
    if (!q) return true
    if (label.toLowerCase().includes(q)) return true
    return childPaths.some((p) => p.toLowerCase().includes(q))
  }

  if (value === null || value === undefined) {
    return (
      <div className="pl-2 font-mono text-[11px] text-slate-500">
        <span className="text-violet-600 dark:text-violet-400">null</span>
      </div>
    )
  }

  if (typeof value !== 'object') {
    const lit =
      typeof value === 'string'
        ? `"${value}"`
        : typeof value === 'boolean'
          ? String(value)
          : String(value)
    return (
      <div className="pl-2 font-mono text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
        <span className={typeof value === 'string' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
          {lit}
        </span>
        <span className="ml-2 rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase text-slate-500 dark:bg-gdc-elevated dark:text-gdc-muted">
          {typeof value}
        </span>
      </div>
    )
  }

  if (Array.isArray(value)) {
    const n = value.length
    const label = `${path.split('.').pop() ?? path}`
    const isExp = expanded.has(path)
    const first = value[0]
    const subPaths = isExp && first !== undefined && typeof first === 'object' ? collectPaths(first, `${path}[0]`) : []
    const show = matches(label, [path, ...subPaths])

    if (!show && !q) return null
    if (!show && q) return null

    const isSel = selectedPath === path
    return (
      <div className={cn('select-none', depth > 0 ? 'border-l border-slate-200/80 pl-2 dark:border-gdc-border' : '')}>
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]',
            isSel ? 'bg-violet-500/15 text-violet-800 ring-1 ring-violet-400/40 dark:text-violet-200' : 'hover:bg-slate-50 dark:hover:bg-gdc-rowHover',
          )}
        >
          <button
            type="button"
            className="rounded p-0.5 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
            onClick={() => onToggle(path)}
            aria-label={isExp ? 'Collapse' : 'Expand'}
          >
            {isExp ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />}
          </button>
          <span className="font-semibold text-slate-800 dark:text-slate-100">{label}</span>
          <span className="rounded bg-slate-100 px-1 text-[9px] font-bold uppercase text-slate-500 dark:bg-gdc-elevated dark:text-gdc-muted">
            array [{n}]
          </span>
          <button
            type="button"
            className="ml-auto text-[10px] font-semibold text-violet-600 hover:underline dark:text-violet-400"
            onClick={() => onSelect(path, value)}
          >
            Use path
          </button>
        </div>
        {isExp && first !== undefined && typeof first === 'object' && !Array.isArray(first) ? (
          <div className="ml-4 mt-0.5 border-l border-slate-200/70 pl-2 dark:border-gdc-border">
            <JsonTree
              value={first}
              path={`${path}[0]`}
              depth={depth + 1}
              search={search}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const labelRoot = path === '$' ? 'root' : path.split(/\.|\[/).pop()?.replace(']', '') ?? path

  const childPaths = entries.flatMap(([k, v]) => collectPaths(v, `${path}.${k}`))
  if (!matches(labelRoot, [path, ...childPaths]) && q) return null

  return (
    <div className={cn(depth > 0 ? 'space-y-0.5' : 'space-y-1')}>
      {entries.map(([key, val]) => {
        const childPath = path === '$' ? `$.${key}` : `${path}.${key}`
        const isObj = val !== null && typeof val === 'object'
        const isArr = Array.isArray(val)
        const isExp = expanded.has(childPath)
        const typeLabel = isArr ? `array [${(val as unknown[]).length}]` : isObj ? 'object' : typeof val

        if (isArr && Array.isArray(val)) {
          return (
            <div key={childPath} className={depth === 0 ? '' : 'ml-1'}>
              <JsonTree
                value={val}
                path={childPath}
                depth={depth + 1}
                search={search}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            </div>
          )
        }

        if (isObj && !isArr) {
          return (
            <div key={childPath} className={cn(depth > 0 ? 'ml-1 border-l border-slate-200/70 pl-2 dark:border-gdc-border' : '')}>
              <button
                type="button"
                onClick={() => onToggle(childPath)}
                className={cn(
                  'flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]',
                  selectedPath === childPath ? 'bg-violet-500/15 ring-1 ring-violet-400/40' : 'hover:bg-slate-50 dark:hover:bg-gdc-rowHover',
                )}
              >
                {isExp ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
                <span className="font-semibold text-slate-800 dark:text-slate-100">{key}</span>
                <span className="rounded bg-slate-100 px-1 text-[9px] font-bold uppercase text-slate-500 dark:bg-gdc-elevated">{typeLabel}</span>
              </button>
              {isExp ? (
                <div className="ml-3 mt-0.5">
                  <JsonTree
                    value={val}
                    path={childPath}
                    depth={depth + 1}
                    search={search}
                    expanded={expanded}
                    selectedPath={selectedPath}
                    onToggle={onToggle}
                    onSelect={onSelect}
                  />
                </div>
              ) : null}
            </div>
          )
        }

        return (
          <div key={childPath} className="flex flex-wrap items-center gap-2 py-0.5 pl-6 font-mono text-[11px]">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{key}</span>
            <span className="text-slate-500">{String(val)}</span>
            <span className="rounded bg-slate-100 px-1 text-[9px] font-bold uppercase text-slate-500 dark:bg-gdc-elevated">{typeof val}</span>
          </div>
        )
      })}
    </div>
  )
}

function collectPaths(v: unknown, base: string): string[] {
  const out: string[] = [base]
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v as object)) {
      out.push(`${base}.${k}`)
    }
  }
  if (Array.isArray(v) && v[0] !== undefined) {
    out.push(...collectPaths(v[0], `${base}[0]`))
  }
  return out
}
export function StreamApiTestPage() {
  const { streamId = '' } = useParams<{ streamId: string }>()
  const navigate = useNavigate()
  const numericId = /^\d+$/.test(streamId) ? Number(streamId) : null

  const [configLoading, setConfigLoading] = useState(() => numericId != null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [streamTitle, setStreamTitle] = useState('')
  const [workflowSourceType, setWorkflowSourceType] = useState<string | null>(null)
  const [sourceKind, setSourceKind] = useState<StandaloneStreamSourceKind>(() => {
    if (numericId != null) return 'UNSUPPORTED'
    return STREAM_ID_SHELL_SOURCE_TYPE_HINT[streamId] ?? 'UNSUPPORTED'
  })
  const [savedStream, setSavedStream] = useState<StreamRead | null>(null)
  const [savedCfg, setSavedCfg] = useState<MappingUIConfigResponse | null>(null)
  const [connectorLabel, setConnectorLabel] = useState<string | null>(null)
  const [connectorId, setConnectorId] = useState<number | null>(null)
  const [method, setMethod] = useState('GET')
  const [baseUrl, setBaseUrl] = useState('')
  const [endpointPath, setEndpointPath] = useState('')
  const [headerChips, setHeaderChips] = useState<Array<{ k: string; v: string }>>([])
  const [queryRows, setQueryRows] = useState<Array<{ key: string; value: string }>>([])
  const [bodyText, setBodyText] = useState('')
  const [mappingEventArrayPath, setMappingEventArrayPath] = useState('')
  const [mappingEventRootPath, setMappingEventRootPath] = useState('')
  const [timeoutSec, setTimeoutSec] = useState('30')
  const [savedQuery, setSavedQuery] = useState('')
  const [savedQueryTimeout, setSavedQueryTimeout] = useState<string>('')
  const [savedRemoteDirectory, setSavedRemoteDirectory] = useState('')
  const [savedFilePattern, setSavedFilePattern] = useState('*')
  const [savedRecursive, setSavedRecursive] = useState(false)
  const [savedMaxObjects, setSavedMaxObjects] = useState('')
  const [savedBucket, setSavedBucket] = useState('')
  const [savedPrefix, setSavedPrefix] = useState('')

  const [httpResult, setHttpResult] = useState<HttpApiTestResponse | null>(null)
  const [samplePayload, setSamplePayload] = useState<unknown>(null)
  const [connectionStatus, setConnectionStatus] = useState<StandaloneConnectionStatus>('idle')
  const [sampleStatus, setSampleStatus] = useState<StandaloneSampleStatus>('idle')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [statusHint, setStatusHint] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const [eventCount, setEventCount] = useState(0)

  const [responseTab, setResponseTab] = useState<ResponseTab>('json')
  const [treeSearch, setTreeSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set<string>(['$']))
  const [selectedTreePath, setSelectedTreePath] = useState('$.')
  const [eventPath, setEventPath] = useState('')
  const [eventRootPathInput, setEventRootPathInput] = useState('')
  const [checkpointPathInput, setCheckpointPathInput] = useState('')
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('basic')
  const [extractionValidationMessage, setExtractionValidationMessage] = useState<string | null>(null)
  const [validatingExtraction, setValidatingExtraction] = useState(false)
  const [pathValidated, setPathValidated] = useState(false)
  const [rootIsArray, setRootIsArray] = useState(false)
  const [maxPreview, setMaxPreview] = useState('500')
  const [dedupeKey, setDedupeKey] = useState('')

  useEffect(() => {
    if (numericId == null) {
      setLoadError('Open this page from Streams using a numeric stream id.')
      setWorkflowSourceType(STREAM_ID_SHELL_SOURCE_TYPE_HINT[streamId] ?? null)
      setSourceKind(STREAM_ID_SHELL_SOURCE_TYPE_HINT[streamId] ?? 'UNSUPPORTED')
      setSavedStream(null)
      setSavedCfg(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setConfigLoading(true)
      setLoadError(null)
      try {
        const [stream, cfg] = await Promise.all([
          fetchStreamById(numericId),
          fetchStreamMappingUiConfig(numericId),
        ])
        if (cancelled) return
        if (!stream || !cfg) {
          setLoadError('Could not load stream or mapping settings.')
          setWorkflowSourceType(null)
          setSourceKind('UNSUPPORTED')
          return
        }
        setSavedStream(stream)
        setSavedCfg(cfg)
        setStreamTitle(cfg.stream_name || stream.name || `Stream ${numericId}`)
        const rawSourceType = firstNonEmptySourceType(cfg.source_type, stream.source_type, stream.stream_type)
        setWorkflowSourceType(rawSourceType)
        const kind = resolveStandaloneStreamSourceKind(stream, cfg)
        setSourceKind(kind)
        const sc = cfg.source_config ?? {}
        const cfgj = (stream.config_json ?? {}) as Record<string, unknown>
        setSavedBucket(String(sc.bucket ?? cfgj.bucket ?? '').trim())
        setSavedPrefix(String(sc.prefix ?? cfgj.prefix ?? '').trim())
        setSavedMaxObjects(
          cfgj.max_objects_per_run != null ? String(cfgj.max_objects_per_run) : '',
        )
        setSavedQuery(String(cfgj.query ?? sc.query ?? '').trim())
        const qt = cfgj.query_timeout_seconds ?? sc.query_timeout_seconds ?? cfgj.timeout_seconds
        setSavedQueryTimeout(qt != null ? String(qt) : '')
        setSavedRemoteDirectory(String(cfgj.remote_directory ?? sc.remote_directory ?? '').trim())
        setSavedFilePattern(String(cfgj.file_pattern ?? sc.file_pattern ?? '*').trim() || '*')
        setSavedRecursive(Boolean(cfgj.recursive ?? sc.recursive ?? false))

        const baseFromSource = String(sc.base_url ?? '').trim()
        const baseFromStream = String(cfgj.base_url ?? '').trim()
        setBaseUrl(baseFromStream || baseFromSource)
        const ep = String(cfgj.endpoint ?? cfgj.endpoint_path ?? sc.endpoint_path ?? '').trim()
        setEndpointPath(ep)
        const m = String(cfgj.method ?? cfgj.http_method ?? sc.http_method ?? 'GET').toUpperCase()
        setMethod(m === 'POST' ? 'POST' : 'GET')
        const hdrRaw = cfgj.headers
        const chips: Array<{ k: string; v: string }> = []
        if (hdrRaw && typeof hdrRaw === 'object' && !Array.isArray(hdrRaw)) {
          for (const [k, v] of Object.entries(hdrRaw as Record<string, unknown>)) {
            chips.push({ k, v: String(v ?? '') })
          }
        }
        setHeaderChips(chips)
        const params = (cfgj.params ?? {}) as Record<string, unknown>
        const rows: Array<{ key: string; value: string }> = []
        for (const [k, v] of Object.entries(params)) {
          rows.push({
            key: k,
            value: v != null && typeof v !== 'object' ? String(v) : JSON.stringify(v),
          })
        }
        setQueryRows(rows)
        const body = cfgj.body ?? cfgj.request_body
        if (body !== undefined && body !== null) {
          setBodyText(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
        } else {
          setBodyText('')
        }
        const ts = cfgj.timeout_seconds ?? cfgj.timeout_sec ?? sc.timeout_sec
        if (typeof ts === 'number' && Number.isFinite(ts)) setTimeoutSec(String(ts))
        else if (typeof ts === 'string' && ts.trim()) setTimeoutSec(ts.trim())

        const eap = cfg.mapping?.event_array_path ?? ''
        const erp = cfg.mapping?.event_root_path ?? ''
        setMappingEventArrayPath(eap)
        setMappingEventRootPath(erp)
        setEventPath(eap)
        setEventRootPathInput(erp)

        const cid = typeof stream.connector_id === 'number' ? stream.connector_id : null
        setConnectorId(cid)
        if (cid != null) {
          const c = await fetchConnectorById(cid)
          if (!cancelled && c) setConnectorLabel(c.name)
        } else {
          setConnectorLabel(null)
        }
        setHttpResult(null)
        setSendError(null)
        if (kind === 'WEBHOOK_RECEIVER') {
          const webhook = buildWebhookStandaloneSampleResult(cfg.source_config)
          setConnectionStatus(webhook.connectionStatus)
          setSampleStatus(webhook.sampleStatus)
          setSamplePayload(webhook.parsedJson)
          setEventCount(webhook.eventCount)
          setStatusMessage(webhook.message)
          setStatusHint(webhook.hint)
        } else if (kind === 'AI_PROXY_RECEIVER' || kind === 'UNSUPPORTED') {
          setConnectionStatus(kind === 'AI_PROXY_RECEIVER' ? 'n_a' : 'unsupported')
          setSampleStatus(kind === 'AI_PROXY_RECEIVER' ? 'not_available' : 'unsupported')
          setSamplePayload(null)
          setEventCount(0)
          setStatusMessage('Sample Not Available')
          setStatusHint(
            kind === 'AI_PROXY_RECEIVER'
              ? 'AI Proxy receiver streams do not support standalone source test.'
              : 'This source type is not supported on standalone Stream Test. Source type is not treated as HTTP.',
          )
        } else {
          setConnectionStatus('idle')
          setSampleStatus('idle')
          setSamplePayload(null)
          setEventCount(0)
          setStatusMessage(null)
          setStatusHint(null)
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load stream')
      } finally {
        if (!cancelled) setConfigLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [numericId, streamId])

  const sampleAvailable = sampleStatus === 'available'
  const previewRoot = useMemo(() => {
    if (!sampleAvailable) return null
    const raw = httpResult?.response?.parsed_json ?? samplePayload
    if (raw !== undefined && raw !== null) return raw
    return null
  }, [httpResult, sampleAvailable, samplePayload])

  const jsonText = useMemo(
    () => (previewRoot === null ? '' : JSON.stringify(previewRoot, null, 2)),
    [previewRoot],
  )
  const rawText = useMemo(() => {
    const raw = httpResult?.response?.raw_body
    return raw != null && String(raw).trim() !== '' ? String(raw) : jsonText
  }, [httpResult, jsonText])

  const headersText = useMemo(() => {
    const h = httpResult?.response?.headers
    if (!h || typeof h !== 'object') return '// (no response headers)'
    const lines = Object.entries(h).map(([k, v]) => `${k}: ${v}`)
    const statusLine = httpResult?.response
      ? `HTTP ${httpResult.response.status_code} (${httpResult.response.latency_ms} ms)`
      : ''
    return [statusLine, ...lines].filter(Boolean).join('\n')
  }, [httpResult])

  const resolvedEvents = previewRoot == null ? undefined : resolveJsonPath(previewRoot, eventPath)
  const arrayEvents = Array.isArray(resolvedEvents) ? resolvedEvents : []
  const firstEvent = arrayEvents[0]
  const eventJsonText = useMemo(() => {
    if (!sampleAvailable) return '// No sample available'
    if (firstEvent !== undefined) return JSON.stringify(firstEvent, null, 2)
    if (previewRoot != null) return JSON.stringify(previewRoot, null, 2)
    return '// No events at this path'
  }, [firstEvent, previewRoot, sampleAvailable])

  const footerPathInfo = useMemo(() => {
    if (previewRoot == null) {
      return { pathLabel: selectedTreePath, typeLabel: '—', length: null as number | null }
    }
    const at = resolveJsonPath(previewRoot, selectedTreePath)
    if (Array.isArray(at)) {
      return { pathLabel: selectedTreePath, typeLabel: 'array', length: at.length }
    }
    if (at !== null && typeof at === 'object') {
      return { pathLabel: selectedTreePath, typeLabel: 'object', length: Object.keys(at).length }
    }
    return {
      pathLabel: selectedTreePath,
      typeLabel: at === null || at === undefined ? 'null' : typeof at,
      length: null as number | null,
    }
  }, [previewRoot, selectedTreePath])

  const leafCount = firstEvent !== undefined && typeof firstEvent === 'object' ? countLeafKeys(firstEvent) : 0

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleTreeSelect = useCallback((path: string, value: unknown) => {
    setSelectedTreePath(path)
    if (Array.isArray(value)) {
      setEventPath(path)
      setPathValidated(true)
    }
  }, [])

  const handleValidate = useCallback(() => {
    if (previewRoot == null) {
      setPathValidated(false)
      setExtractionValidationMessage('Load an actual sample before validating extraction paths.')
      return
    }
    if (extractionMode === 'basic') {
      const v = resolveJsonPath(previewRoot, eventPath)
      setPathValidated(Array.isArray(v) && v.length > 0)
      setExtractionValidationMessage(null)
      return
    }

    if (!httpResult?.response?.parsed_json && samplePayload == null) {
      setPathValidated(false)
      setExtractionValidationMessage('Load an actual sample before validating extraction paths.')
      return
    }

    setValidatingExtraction(true)
    setExtractionValidationMessage(null)
    void runExtractionValidate({
      payload: httpResult?.response?.parsed_json ?? samplePayload,
      event_array_path: eventPath || null,
      event_root_path: eventRootPathInput || null,
      checkpoint_path: checkpointPathInput || null,
      max_preview_events: 3,
    })
      .then((res: ExtractionValidateResponse) => {
        if (res.normalized_event_array_path != null) setEventPath(res.normalized_event_array_path)
        if (res.normalized_event_root_path != null) setEventRootPathInput(res.normalized_event_root_path)
        if (res.normalized_checkpoint_path != null) setCheckpointPathInput(res.normalized_checkpoint_path)
        setPathValidated(res.ok && res.event_count > 0)
        const warningCount = res.warnings.length
        const errorCount = res.errors.length
        if (res.ok) {
          setExtractionValidationMessage(
            `Validated: ${res.event_count} event(s) extracted${warningCount > 0 ? `, ${warningCount} warning(s)` : ''}.`,
          )
        } else {
          setExtractionValidationMessage(
            `Validation failed: ${errorCount} error(s)${warningCount > 0 ? `, ${warningCount} warning(s)` : ''}.`,
          )
        }
      })
      .catch((err) => {
        setPathValidated(false)
        setExtractionValidationMessage(`Validation request failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setValidatingExtraction(false))
  }, [checkpointPathInput, eventPath, eventRootPathInput, extractionMode, httpResult?.response?.parsed_json, previewRoot, samplePayload])

  const sendRequest = useCallback(async () => {
    if (numericId == null || requestBusy || !savedStream || !savedCfg) return
    if (sourceKind === 'WEBHOOK_RECEIVER' || sourceKind === 'AI_PROXY_RECEIVER' || sourceKind === 'UNSUPPORTED') {
      return
    }
    let jsonBody: unknown | undefined
    if (sourceKind === 'HTTP_API_POLLING') {
      const trimmed = bodyText.trim()
      if (trimmed) {
        try {
          jsonBody = JSON.parse(trimmed) as unknown
        } catch (e) {
          setSendError(e instanceof Error ? e.message : 'Invalid JSON body')
          return
        }
      }
    }
    setRequestBusy(true)
    setSendError(null)
    setHttpResult(null)
    try {
      const params: Record<string, string> = {}
      for (const r of queryRows) {
        const k = r.key.trim()
        if (!k) continue
        params[k] = r.value
      }
      const headersObj: Record<string, string> = {}
      for (const h of headerChips) {
        const k = h.k.trim()
        if (k) headersObj[k] = h.v
      }
      const result = await runStandaloneStreamSourceTest({
        sourceKind,
        stream: savedStream,
        cfg: savedCfg,
        connectorId,
        httpOverrides:
          sourceKind === 'HTTP_API_POLLING'
            ? {
                method,
                endpoint: endpointPath.trim(),
                baseUrl: baseUrl.trim(),
                headers: headersObj,
                params,
                body: jsonBody,
                timeoutSeconds: Number.parseInt(timeoutSec, 10) || 30,
              }
            : null,
      })
      setHttpResult(result.httpResult)
      setSamplePayload(result.parsedJson)
      setConnectionStatus(result.connectionStatus)
      setSampleStatus(result.sampleStatus)
      setEventCount(result.eventCount)
      setStatusMessage(result.message)
      setStatusHint(result.hint)
      if (result.sampleStatus === 'failed' || result.connectionStatus === 'fail') {
        setSendError(result.message)
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Request failed')
      setConnectionStatus('fail')
      setSampleStatus('failed')
    } finally {
      setRequestBusy(false)
    }
  }, [
    numericId,
    requestBusy,
    savedStream,
    savedCfg,
    sourceKind,
    endpointPath,
    connectorId,
    baseUrl,
    bodyText,
    queryRows,
    headerChips,
    method,
    timeoutSec,
  ])

  const addQueryRow = useCallback(() => {
    setQueryRows((rows) => [...rows, { key: '', value: '' }])
  }, [])

  const statsStatus = httpResult?.response?.status_code
  const statsLatency = httpResult?.response?.latency_ms
  const statsSize = httpResult?.response?.raw_body?.length ?? jsonText.length

  const streamSourceTestTitle = useMemo(
    () => resolveStreamSourceTestShellTitle(streamId, workflowSourceType),
    [streamId, workflowSourceType],
  )

  const streamSourceTestIntro = useMemo(
    () => resolveStreamSourceTestPageIntro(streamId, workflowSourceType),
    [streamId, workflowSourceType],
  )

  const workflowSnapshot = useMemo(
    () =>
      computeStreamWorkflow({
        streamId,
        status: 'STOPPED',
        events1h: 0,
        deliveryPct: 0,
        routesTotal: 0,
        routesOk: 0,
        hasConnector: connectorId != null || baseUrl.trim().length > 0,
        hasApiTest: sampleStatus === 'available',
        sourceType: workflowSourceType,
      }),
    [streamId, connectorId, baseUrl, sampleStatus, workflowSourceType],
  )

  const fullUrlPreview = `${baseUrl}${endpointPath}`

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 pb-28">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">{streamSourceTestTitle}</h2>
          <p className="max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">{streamSourceTestIntro}</p>
          {configLoading ? (
            <p className="inline-flex items-center gap-2 text-[12px] text-slate-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Loading stream settings…
            </p>
          ) : null}
          {loadError ? <p className="text-[12px] font-medium text-amber-800 dark:text-amber-200">{loadError}</p> : null}
          {numericId != null ? (
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
              <span className="font-semibold text-slate-800 dark:text-slate-200">{streamTitle}</span>{' '}
              <span className="font-mono text-slate-500">stream_id={numericId}</span>
              {connectorLabel ? (
                <>
                  {' '}
                  · Connector <span className="font-semibold">{connectorLabel}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => navigate(streamMappingPath(streamId))}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md bg-violet-600 px-4 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
        >
          Save & Continue
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <StreamWorkflowSummaryStrip snapshot={workflowSnapshot} activeStep="apiTest" highlightCompleted={['connector']} />

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">1</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {sourceKind === 'HTTP_API_POLLING' ? 'Request Configuration' : 'Saved source configuration'}
              </h3>
              <span className="rounded-md border border-slate-200/90 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-300">
                {sourceKind}
              </span>
            </div>
            {configLoading ? (
              <p className="mt-4 text-[12px] text-slate-600 dark:text-gdc-muted">Loading saved source configuration…</p>
            ) : sourceKind !== 'HTTP_API_POLLING' ? (
              <div className="mt-4 space-y-3" data-testid="standalone-non-http-config">
                {sourceKind === 'S3_OBJECT_POLLING' ? (
                  <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
                    <div><dt className="text-slate-500">Bucket</dt><dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedBucket || '—'}</dd></div>
                    <div><dt className="text-slate-500">Prefix</dt><dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedPrefix || '—'}</dd></div>
                    <div><dt className="text-slate-500">max_objects_per_run</dt><dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedMaxObjects || '—'}</dd></div>
                  </dl>
                ) : null}
                {sourceKind === 'DATABASE_QUERY' ? (
                  <dl className="grid gap-2 text-[12px]">
                    <div>
                      <dt className="text-slate-500">Saved query</dt>
                      <dd className="mt-1 whitespace-pre-wrap rounded-md border border-slate-200/90 bg-slate-50 p-2 font-mono text-[11px] text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100">
                        {savedQuery || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">query_timeout_seconds</dt>
                      <dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedQueryTimeout || '—'}</dd>
                    </div>
                  </dl>
                ) : null}
                {sourceKind === 'REMOTE_FILE_POLLING' ? (
                  <dl className="grid gap-2 text-[12px] sm:grid-cols-2">
                    <div><dt className="text-slate-500">remote_directory</dt><dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedRemoteDirectory || '—'}</dd></div>
                    <div><dt className="text-slate-500">file_pattern</dt><dd className="font-mono font-semibold text-slate-800 dark:text-slate-100">{savedFilePattern}</dd></div>
                    <div><dt className="text-slate-500">recursive</dt><dd className="font-semibold text-slate-800 dark:text-slate-100">{savedRecursive ? 'yes' : 'no'}</dd></div>
                  </dl>
                ) : null}
                {sourceKind === 'WEBHOOK_RECEIVER' ? (
                  <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
                    Webhook receivers cannot live-fetch. Standalone Test uses the operator <span className="font-semibold">sample_payload</span> from the saved source when present.
                  </p>
                ) : null}
                {sourceKind === 'AI_PROXY_RECEIVER' || sourceKind === 'UNSUPPORTED' ? (
                  <p data-testid="standalone-unsupported-source" className="rounded-md border border-amber-200/80 bg-amber-500/[0.07] p-3 text-[12px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
                    {statusMessage ?? 'Sample Not Available'}
                    {statusHint ? <span className="mt-1 block text-[11px] opacity-90">{statusHint}</span> : null}
                  </p>
                ) : null}
                {sourceKind === 'S3_OBJECT_POLLING' || sourceKind === 'DATABASE_QUERY' || sourceKind === 'REMOTE_FILE_POLLING' ? (
                  <button
                    type="button"
                    data-testid="standalone-source-test-run"
                    onClick={() => void sendRequest()}
                    disabled={requestBusy || numericId == null || configLoading}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-70"
                  >
                    {requestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Run Test
                  </button>
                ) : null}
                {sendError ? <p className="text-[12px] font-medium text-red-700 dark:text-red-300">{sendError}</p> : null}
              </div>
            ) : (
            <>
            <div className="mt-4 flex flex-col gap-3 lg:flex-row">
              <div className="flex min-w-0 flex-1 gap-2">
                <label className="sr-only" htmlFor="api-method">
                  HTTP method
                </label>
                <select
                  id="api-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="h-9 w-20 shrink-0 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] font-semibold dark:border-gdc-border dark:bg-gdc-card"
                >
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                </select>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label className="text-[10px] font-semibold text-slate-500 dark:text-gdc-muted">Base URL</label>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 font-mono text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                    placeholder="https://"
                    aria-label="Base URL"
                  />
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  data-testid="standalone-source-test-run"
                  onClick={() => void sendRequest()}
                  disabled={requestBusy || numericId == null || configLoading}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-70"
                >
                  {requestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Send Request
                </button>
              </div>
            </div>
            <div className="mt-3">
              <label className="text-[10px] font-semibold text-slate-500 dark:text-gdc-muted">Endpoint path</label>
              <input
                value={endpointPath}
                onChange={(e) => setEndpointPath(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                placeholder="/path"
              />
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-slate-600 dark:text-gdc-muted">
              Full URL: <span className="font-semibold text-slate-900 dark:text-slate-100">{fullUrlPreview || '—'}</span>
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-slate-500 dark:text-gdc-muted">Authentication</span>
              <span className="text-[11px] text-slate-600 dark:text-gdc-muted">
                Connector credentials are loaded server-side (masked configuration).
              </span>
            </div>

            <div className="mt-4">
              <p className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">Headers</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {headerChips.length === 0 ? (
                  <span className="text-[11px] text-slate-500 dark:text-gdc-muted">(no headers configured)</span>
                ) : (
                  headerChips.map((h) => (
                    <span
                      key={h.k}
                      className="inline-flex items-center rounded-md border border-slate-200/90 bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200"
                    >
                      <span className="font-semibold text-violet-700 dark:text-violet-300">{h.k}</span>
                      <span className="mx-1 text-slate-400">:</span>
                      {h.v}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="mt-4">
              <p className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">Query Parameters</p>
              <div className="mt-2 space-y-2">
                {queryRows.length === 0 ? (
                  <p className="text-[11px] text-slate-500 dark:text-gdc-muted">(empty)</p>
                ) : (
                  queryRows.map((row, idx) => (
                    <div key={`${row.key}-${idx}`} className="flex flex-wrap gap-2">
                      <input
                        value={row.key}
                        onChange={(e) => {
                          const next = [...queryRows]
                          next[idx] = { ...row, key: e.target.value }
                          setQueryRows(next)
                        }}
                        className="h-8 min-w-[120px] flex-1 rounded-md border border-slate-200/90 px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                        placeholder="key"
                        aria-label={`Query parameter key ${idx + 1}`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) => {
                          const next = [...queryRows]
                          next[idx] = { ...row, value: e.target.value }
                          setQueryRows(next)
                        }}
                        className="h-8 min-w-[160px] flex-[2] rounded-md border border-slate-200/90 px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                        placeholder="value"
                        aria-label={`Query parameter value ${idx + 1}`}
                      />
                    </div>
                  ))
                )}
              </div>
              <button
                type="button"
                onClick={addQueryRow}
                className="mt-2 text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                + Add Parameter
              </button>
            </div>

            <div className="mt-4">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">JSON body (optional)</label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={5}
                className="mt-1 w-full rounded-md border border-slate-200/90 bg-white px-2 py-1.5 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-card"
                spellCheck={false}
              />
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">
                Timeout (sec)
                <input
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-slate-200/90 px-2 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                />
              </label>
              <div className="text-[11px] text-slate-600 dark:text-gdc-muted">
                <p className="font-semibold text-slate-700 dark:text-gdc-mutedStrong">Mapping (saved)</p>
                <p className="mt-1 font-mono text-[10px]">event_array_path: {mappingEventArrayPath || '—'}</p>
                <p className="font-mono text-[10px]">event_root_path: {mappingEventRootPath || '—'}</p>
              </div>
            </div>
            {sendError ? <p className="mt-2 text-[12px] font-medium text-red-700 dark:text-red-300">{sendError}</p> : null}
            </>
            )}
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">2</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Response Preview</h3>
            </div>
            <div className="mt-3 flex gap-1 border-b border-slate-200/80 dark:border-gdc-border">
              {(['json', 'raw', 'headers'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setResponseTab(tab)}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-1.5 text-[12px] font-semibold capitalize',
                    responseTab === tab
                      ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                  )}
                >
                  {tab === 'json' ? 'JSON' : tab}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {!sampleAvailable ? (
                <p
                  data-testid={sampleStatus === 'no_records' ? 'standalone-sample-no-records' : 'standalone-sample-not-available'}
                  className="rounded-md border border-amber-200/80 bg-amber-500/[0.07] p-3 text-[12px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
                >
                  {sampleStatus === 'no_records'
                    ? `${standaloneConnectionStatusLabel(connectionStatus)} / ${standaloneSampleStatusLabel(sampleStatus)}`
                    : standaloneSampleStatusLabel(sampleStatus)}
                  {statusMessage ? <span className="mt-1 block">{statusMessage}</span> : null}
                  {statusHint ? <span className="mt-1 block text-[11px] opacity-90">{statusHint}</span> : null}
                </p>
              ) : (
                <>
                  {responseTab === 'json' ? <JsonCodeView text={jsonText} /> : null}
                  {responseTab === 'raw' ? <JsonCodeView text={rawText} /> : null}
                  {responseTab === 'headers' ? <JsonCodeView text={headersText} /> : null}
                </>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 font-mono text-[10px] text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
              <span>
                JSON Path: <span className="font-semibold text-slate-700 dark:text-slate-200">{footerPathInfo.pathLabel}</span>
              </span>
              <span>
                Type: <span className="font-semibold text-slate-700 dark:text-slate-200">{footerPathInfo.typeLabel}</span>
              </span>
              {footerPathInfo.length !== null ? (
                <span>
                  Length: <span className="font-semibold text-slate-700 dark:text-slate-200">{footerPathInfo.length}</span>
                </span>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">3</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">JSON Tree</h3>
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
              <input
                value={treeSearch}
                onChange={(e) => setTreeSearch(e.target.value)}
                placeholder="Search fields…"
                className="h-9 w-full rounded-md border border-slate-200/90 bg-white py-1 pl-8 pr-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                aria-label="Search JSON tree"
              />
            </div>
            <div className="mt-3 max-h-[min(320px,50vh)] overflow-auto rounded-lg border border-slate-200/80 bg-slate-50/80 p-2 dark:border-gdc-border dark:bg-gdc-card">
              {previewRoot == null ? (
                <p className="p-2 text-[12px] text-slate-500 dark:text-gdc-muted">No actual sample to display.</p>
              ) : (
                <JsonTree
                  value={previewRoot}
                  path="$"
                  depth={0}
                  search={treeSearch}
                  expanded={expanded}
                  selectedPath={selectedTreePath}
                  onToggle={handleToggle}
                  onSelect={handleTreeSelect}
                />
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">4</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Event Preview (first item)</h3>
            </div>
            <div className="mt-3">
              <JsonCodeView text={eventJsonText} />
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
                <dt className="text-slate-500">Events in response</dt>
                <dd className="font-semibold text-slate-800 dark:text-slate-100">{arrayEvents.length}</dd>
              </div>
              <div className="flex justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
                <dt className="text-slate-500">Currently selected path</dt>
                <dd className="truncate font-mono font-semibold text-violet-700 dark:text-violet-300">{eventPath}</dd>
              </div>
              <div className="flex justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
                <dt className="text-slate-500">Event fields</dt>
                <dd className="font-semibold text-slate-800 dark:text-slate-100">{leafCount}</dd>
              </div>
              <div className="flex justify-between gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
                <dt className="text-slate-500">Sample size</dt>
                <dd className="font-semibold text-slate-800 dark:text-slate-100">1</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">5</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Event Path Configuration</h3>
            </div>
            <div className="mt-3 inline-flex rounded-md border border-slate-200/80 bg-slate-50 p-0.5 dark:border-gdc-border dark:bg-gdc-elevated">
              <button
                type="button"
                onClick={() => {
                  setExtractionMode('basic')
                  setExtractionValidationMessage(null)
                }}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold',
                  extractionMode === 'basic'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                )}
              >
                Basic (Tree)
              </button>
              <button
                type="button"
                onClick={() => {
                  setExtractionMode('advanced')
                  setExtractionValidationMessage(null)
                }}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold',
                  extractionMode === 'advanced'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                )}
              >
                Advanced (Custom)
              </button>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor="event-path" className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">
                  Event array path <span className="text-red-600">*</span>
                </label>
                <input
                  id="event-path"
                  value={eventPath}
                  onChange={(e) => {
                    setEventPath(e.target.value)
                    setPathValidated(false)
                  }}
                  className="mt-1 h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                />
              </div>
              <button
                type="button"
                onClick={handleValidate}
                disabled={validatingExtraction}
                className="inline-flex h-9 shrink-0 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              >
                {validatingExtraction ? 'Validating…' : 'Validate'}
              </button>
            </div>
            {extractionMode === 'advanced' ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">Event root path</label>
                  <input
                    value={eventRootPathInput}
                    onChange={(e) => {
                      setEventRootPathInput(e.target.value)
                      setPathValidated(false)
                    }}
                    placeholder="$.event (optional)"
                    className="mt-1 h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted">Sync position path</label>
                  <input
                    value={checkpointPathInput}
                    onChange={(e) => {
                      setCheckpointPathInput(e.target.value)
                      setPathValidated(false)
                    }}
                    placeholder="$.eventTime (optional)"
                    className="mt-1 h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 font-mono text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                  />
                </div>
              </div>
            ) : null}
            {pathValidated ? (
              <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Valid path. {arrayEvents.length} events found.
              </p>
            ) : (
              <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-400">
                Load an actual sample, then confirm the path points at an array.
              </p>
            )}
            {extractionValidationMessage ? (
              <p className="mt-1 text-[12px] text-slate-700 dark:text-slate-200">{extractionValidationMessage}</p>
            ) : null}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-24 xl:self-start">
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Status Summary</h3>
            <ul className="mt-3 space-y-2 text-[12px]">
              <li className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Source type</span>
                <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{sourceKind}</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Connection</span>
                <span data-testid="standalone-connection-status" className="font-semibold text-slate-800 dark:text-slate-100">
                  {standaloneConnectionStatusLabel(connectionStatus)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Sample</span>
                <span data-testid="standalone-sample-status" className="font-semibold text-slate-800 dark:text-slate-100">
                  {standaloneSampleStatusLabel(sampleStatus)}
                </span>
              </li>
              {sourceKind === 'HTTP_API_POLLING' ? (
                <li className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">HTTP status</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{statsStatus ?? '—'}</span>
                </li>
              ) : null}
              <li className="flex justify-between gap-2">
                <span className="text-slate-500">Response Time</span>
                <span className="font-semibold text-slate-800 dark:text-slate-100">
                  {statsLatency != null ? `${statsLatency} ms` : '—'}
                </span>
              </li>
              <li className="flex justify-between gap-2">
                <span className="text-slate-500">Approx size</span>
                <span className="font-semibold text-slate-800 dark:text-slate-100">{sampleAvailable ? formatBytes(statsSize) : '—'}</span>
              </li>
              <li className="flex justify-between gap-2">
                <span className="text-slate-500">Records</span>
                <span className="font-semibold text-slate-800 dark:text-slate-100">{sampleAvailable ? eventCount : '—'}</span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Extraction Settings</h3>
            <div className="mt-3 space-y-3">
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-gdc-muted">Array Path</label>
                <input
                  readOnly
                  value={eventPath}
                  className="mt-1 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50 px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-card"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Root is Array</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={rootIsArray}
                  onClick={() => setRootIsArray((v) => !v)}
                  className={cn(
                    'relative h-6 w-10 rounded-full transition-colors',
                    rootIsArray ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-gdc-elevated',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                      rootIsArray ? 'left-4' : 'left-0.5',
                    )}
                  />
                </button>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-gdc-muted">Max Events to Preview</label>
                <select
                  value={maxPreview}
                  onChange={(e) => setMaxPreview(e.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600 dark:text-gdc-muted">Event Deduplication Key (optional)</label>
                <input
                  value={dedupeKey}
                  onChange={(e) => setDedupeKey(e.target.value)}
                  placeholder="e.g. id"
                  className="mt-1 h-8 w-full rounded-md border border-slate-200/90 px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                />
              </div>
              <button
                type="button"
                disabled={
                  requestBusy ||
                  numericId == null ||
                  configLoading ||
                  sourceKind === 'WEBHOOK_RECEIVER' ||
                  sourceKind === 'AI_PROXY_RECEIVER' ||
                  sourceKind === 'UNSUPPORTED'
                }
                onClick={() => void sendRequest()}
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-200/90 bg-white text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              >
                {requestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                Refresh Preview
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Next Steps</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-[12px] text-slate-600 dark:text-gdc-muted">
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Configure Mapping</span> — map source fields to your canonical schema.
              </li>
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Configure Enrichment</span> — add static fields or lookups.
              </li>
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Add Destination & Route Policy</span> — connect stream fan-out and failure policy.
              </li>
            </ol>
            <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-muted">
              This page uses the saved stream/source configuration and the existing runtime preview contract. Connection success is not the same as sample available.
            </p>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <p className="text-[12px] text-slate-600 dark:text-gdc-muted">문서</p>
            <a
              href="https://example.com/docs"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              View Docs
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </section>
        </aside>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200/90 bg-white/95 px-3 py-2.5 backdrop-blur-md dark:border-gdc-border dark:bg-gdc-section md:pl-[var(--sidebar-offset,0px)]">
        <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-2 lg:justify-between">
          <ol className="flex flex-wrap items-center justify-center gap-2">
            {WIZARD_STEPS.map((step, index) => {
              const done = index < ACTIVE_WIZARD_STEP
              const active = index === ACTIVE_WIZARD_STEP
              return (
                <li key={step.key} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border text-[10px] font-bold',
                      done
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : active
                          ? 'border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                          : 'border-slate-300 bg-white text-slate-500 dark:border-gdc-border dark:bg-gdc-card',
                    )}
                  >
                    {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : active ? <Circle className="h-3 w-3 fill-violet-600 text-violet-600" /> : index + 1}
                  </span>
                  <span
                    className={cn(
                      'hidden text-[10px] font-semibold sm:inline',
                      active ? 'text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-gdc-muted',
                    )}
                  >
                    {step.title}
                  </span>
                  {index < WIZARD_STEPS.length - 1 ? (
                    <ChevronRight className="hidden h-3 w-3 text-slate-300 lg:inline" aria-hidden />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    </div>
  )
}
