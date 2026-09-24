import type { EngineInterface, Register, SessionMessage, Timer } from 'claude-code'
import { raceDeadline } from './deadline.ts'
import {
  canonical,
  fingerprint,
  reviewPending,
  sanitize,
  ReviewFailure,
  type OwnerMessage,
  type ReviewResult,
} from './reviewer.ts'
import { classifyWorkspaceMutation } from './workspace.ts'

const DEADLINE_MS = 60_000
const STORE_PREFIX = 'session:'
const STORE_INDEX = 'session-index'
const MAX_OWNER_MESSAGES = 256
const MAX_OWNER_BYTES = 48 * 1024
const MAX_HISTORY = 20
const MAX_LOADED_HISTORY = 128
const MAX_HISTORY_BYTES = 16 * 1024
const MAX_LOADED_HISTORY_BYTES = 64 * 1024
const MAX_SESSION_BYTES = 512 * 1024
const MAX_STORED_SESSIONS = 8
const MAX_STORE_BYTES = 3 * 1024 * 1024
export const DEFAULT_MODEL = 'sonnet'
export const selectedModel = (value: unknown) =>
  typeof value === 'string' && value ? value : DEFAULT_MODEL

type Availability = 'checking' | 'active' | 'unavailable'

type HistoryEntry = {
  requestId: string
  fingerprint: string
  action: string
  verdict: 'allow' | 'deny'
  reason: string
  elapsedMs: number
  at: number
  attempts?: number
  risk?: string
  authorization?: string
  evidenceIds?: string[]
  failureKind?: string
}

type StoredState = {
  sessionId: string
  workspace: string
  generation: number
  instructionGeneration: number
  permissionGeneration: number
  planMode: boolean
  nextOwnerId: number
  ownerMessages: OwnerMessage[]
  agentTasks: [string, string][]
  history: HistoryEntry[]
  contextGap: boolean
  closed: boolean
  touchedAt: number
}

type SessionState = StoredState & {
  availability: Availability
  integrityInvalid: boolean
  storeLoadFailed: boolean
  write: Promise<void>
}

type CallRecord = {
  key: string
  sessionId: string
  toolUseId: string
  tool: string
  input: unknown
  agentId?: string
  cwd: string
  root: string
  startedAt: number
  actionCanonical: string
  actionFingerprint: string
  deadline: Promise<void>
  deadlineTimer?: Timer
  expired: boolean
  finalFailure?: string
  generation: number
  closed: boolean
}

type StoreIndexEntry = {
  sessionId: string
  closed: boolean
  touchedAt: number
  bytes: number
}

const states = new Map<string, SessionState>()
type StateLoad = {
  epoch: number
  promise: Promise<SessionState>
}

type SessionLifecycle = {
  epoch: number
  closed: boolean
}

const stateLoads = new Map<string, StateLoad>()
const sessionLifecycles = new Map<string, SessionLifecycle>()
const sessionWorkspaces = new Map<string, string>()
const calls = new Map<string, CallRecord>()
let globallyInvalid = false
let storeWrite = Promise.resolve()

const textBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

const scope = (workspace: string) => encodeURIComponent(workspace)
const storeKey = (workspace: string, sessionId: string) =>
  `${STORE_PREFIX}${scope(workspace)}:${sessionId}`
const indexKey = (workspace: string) => `${STORE_INDEX}:${scope(workspace)}`

const lifecycleFor = (sessionId: string): SessionLifecycle =>
  sessionLifecycles.get(sessionId) ?? { epoch: 0, closed: false }

function beginLifecycle(sessionId: string) {
  const lifecycle = lifecycleFor(sessionId)
  const next = { epoch: lifecycle.epoch + 1, closed: false }
  sessionLifecycles.set(sessionId, next)
  return next.epoch
}

function endLifecycle(sessionId: string) {
  const lifecycle = lifecycleFor(sessionId)
  const next = { epoch: lifecycle.epoch + 1, closed: true }
  sessionLifecycles.set(sessionId, next)
  stateLoads.delete(sessionId)
  return next.epoch
}

const lifecycleIsCurrent = (
  sessionId: string,
  epoch: number,
  allowClosed = false,
) => {
  const lifecycle = lifecycleFor(sessionId)
  return lifecycle.epoch === epoch && (allowClosed || !lifecycle.closed)
}

const lifecycleTombstone = (sessionId: string) => {
  const tombstone = freshState(sessionId, 0, '')
  tombstone.closed = true
  tombstone.availability = 'unavailable'
  return tombstone
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function isOwnerMessage(value: unknown): value is OwnerMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.original === 'string' &&
    (value.transformed === undefined || typeof value.transformed === 'string') &&
    isNumber(value.at)
  )
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.action === 'string' &&
    (value.verdict === 'allow' || value.verdict === 'deny') &&
    typeof value.reason === 'string' &&
    isNumber(value.elapsedMs) &&
    isNumber(value.at) &&
    (value.attempts === undefined ||
      (typeof value.attempts === 'number' &&
        Number.isInteger(value.attempts) &&
        value.attempts >= 1 &&
        value.attempts <= 3)) &&
    (value.risk === undefined || typeof value.risk === 'string') &&
    (value.authorization === undefined || typeof value.authorization === 'string') &&
    (value.failureKind === undefined || typeof value.failureKind === 'string') &&
    (value.evidenceIds === undefined ||
      (Array.isArray(value.evidenceIds) &&
        value.evidenceIds.every(item => typeof item === 'string')))
  )
}

function isStoredState(value: unknown, sessionId: string, workspace: string): value is StoredState {
  const ownerIds = isRecord(value) && Array.isArray(value.ownerMessages)
    ? value.ownerMessages.map(item => (isRecord(item) ? item.id : undefined))
    : []
  const agentIds = isRecord(value) && Array.isArray(value.agentTasks)
    ? value.agentTasks.map(item => (Array.isArray(item) ? item[0] : undefined))
    : []
  const requestIds = isRecord(value) && Array.isArray(value.history)
    ? value.history.map(item => (isRecord(item) ? item.requestId : undefined))
    : []
  return (
    isRecord(value) &&
    value.sessionId === sessionId &&
    value.workspace === workspace &&
    Number.isInteger(value.generation) &&
    isNumber(value.generation) &&
    Number.isInteger(value.instructionGeneration) &&
    isNumber(value.instructionGeneration) &&
    Number.isInteger(value.permissionGeneration) &&
    isNumber(value.permissionGeneration) &&
    typeof value.planMode === 'boolean' &&
    Number.isInteger(value.nextOwnerId) &&
    isNumber(value.nextOwnerId) &&
    Array.isArray(value.ownerMessages) &&
    value.ownerMessages.every(isOwnerMessage) &&
    new Set(ownerIds).size === ownerIds.length &&
    value.ownerMessages.length <= MAX_OWNER_MESSAGES &&
    textBytes(value.ownerMessages) <= MAX_OWNER_BYTES &&
    Array.isArray(value.agentTasks) &&
    value.agentTasks.every(
      item =>
        Array.isArray(item) &&
        item.length === 2 &&
        item.every(part => typeof part === 'string'),
    ) &&
    new Set(agentIds).size === agentIds.length &&
    value.agentTasks.length <= 128 &&
    Array.isArray(value.history) &&
    value.history.every(isHistoryEntry) &&
    new Set(requestIds).size === requestIds.length &&
    value.history.length <= MAX_LOADED_HISTORY &&
    textBytes(value.history) <= MAX_LOADED_HISTORY_BYTES &&
    typeof value.contextGap === 'boolean' &&
    typeof value.closed === 'boolean' &&
    isNumber(value.touchedAt) &&
    textBytes(value) <= MAX_SESSION_BYTES
  )
}

const freshState = (sessionId: string, now: number, workspace: string): SessionState => ({
  sessionId,
  workspace,
  generation: 1,
  instructionGeneration: 0,
  permissionGeneration: 0,
  planMode: false,
  nextOwnerId: 1,
  ownerMessages: [],
  agentTasks: [],
  history: [],
  contextGap: false,
  closed: false,
  touchedAt: now,
  availability: 'checking',
  integrityInvalid: false,
  storeLoadFailed: false,
  write: Promise.resolve(),
})

function restoredState(value: unknown, sessionId: string, now: number, workspace: string): SessionState {
  if (value === undefined) {
    return freshState(sessionId, now, workspace)
  }
  if (!isStoredState(value, sessionId, workspace)) {
    return {
      ...freshState(sessionId, now, workspace),
      contextGap: true,
      integrityInvalid: true,
      availability: 'unavailable',
    }
  }
  const stored = value
  return {
    ...freshState(sessionId, now, workspace),
    generation: stored.generation + 1,
    instructionGeneration: stored.instructionGeneration,
    permissionGeneration: stored.permissionGeneration,
    planMode: stored.planMode,
    nextOwnerId: Math.max(1, stored.nextOwnerId),
    ownerMessages: stored.ownerMessages.slice(),
    agentTasks: stored.agentTasks.slice(),
    history: stored.history.slice(),
    contextGap: stored.contextGap,
    closed: stored.closed,
    touchedAt: now,
  }
}

async function stateFor(
  $: EngineInterface,
  sessionId: string,
  expectedEpoch = lifecycleFor(sessionId).epoch,
  workspace?: string,
): Promise<SessionState> {
  const lifecycle = lifecycleFor(sessionId)
  if (lifecycle.epoch !== expectedEpoch) return lifecycleTombstone(sessionId)
  const current = states.get(sessionId)
  if (current) {
    if (workspace === undefined && current.workspace !== sessionWorkspaces.get(sessionId)) {
      return lifecycleTombstone(sessionId)
    }
    return current
  }
  if (lifecycle.closed) return lifecycleTombstone(sessionId)
  const loading = stateLoads.get(sessionId)
  if (loading?.epoch === expectedEpoch) return loading.promise

  let promise!: Promise<SessionState>
  promise = (async () => {
    const now = await $.clock.now()
    // /clear can skip session.start, so the first state access binds its workspace.
    const directory = workspace ?? sessionWorkspaces.get(sessionId) ?? await $.session.cwd()
    let saved: unknown
    let storeLoadFailed = false
    try {
      saved = await $.store.get(storeKey(directory, sessionId))
    } catch {
      storeLoadFailed = true
    }
    if (!lifecycleIsCurrent(sessionId, expectedEpoch)) {
      return lifecycleTombstone(sessionId)
    }
    const state = restoredState(saved, sessionId, now, directory)
    if (storeLoadFailed) {
      state.integrityInvalid = true
      state.storeLoadFailed = true
      state.availability = 'unavailable'
    }
    enforceCaps(state)
    if (!lifecycleIsCurrent(sessionId, expectedEpoch)) {
      return lifecycleTombstone(sessionId)
    }
    if (!sessionWorkspaces.has(sessionId)) sessionWorkspaces.set(sessionId, directory)
    states.set(sessionId, state)
    if (stateLoads.get(sessionId)?.promise === promise) stateLoads.delete(sessionId)
    return state
  })().catch((error: unknown) => {
    if (stateLoads.get(sessionId)?.promise === promise) stateLoads.delete(sessionId)
    throw error
  })
  stateLoads.set(sessionId, { epoch: expectedEpoch, promise })
  return promise
}

async function startingStateFor(
  $: EngineInterface,
  sessionId: string,
  expectedEpoch: number,
  workspace: string,
): Promise<SessionState> {
  const state = await stateFor($, sessionId, expectedEpoch, workspace)
  if (
    !lifecycleIsCurrent(sessionId, expectedEpoch) ||
    states.get(sessionId) !== state
  ) {
    return lifecycleTombstone(sessionId)
  }
  if (state.workspace !== workspace) {
    const changed = freshState(sessionId, await $.clock.now(), workspace)
    changed.contextGap = true
    changed.integrityInvalid = true
    changed.write = state.write
    states.set(sessionId, changed)
    return changed
  }
  if (!state.closed) return state
  const now = await $.clock.now()
  if (
    !lifecycleIsCurrent(sessionId, expectedEpoch) ||
    states.get(sessionId) !== state
  ) {
    return lifecycleTombstone(sessionId)
  }
  const restored = restoredState(storedOf(state), sessionId, now, workspace)
  restored.closed = false
  restored.integrityInvalid = state.integrityInvalid
  restored.storeLoadFailed = state.storeLoadFailed
  restored.write = state.write
  enforceCaps(restored)
  for (const [key, call] of calls) {
    if (call.sessionId === sessionId) {
      call.closed = true
      calls.delete(key)
    }
  }
  if (!lifecycleIsCurrent(sessionId, expectedEpoch)) {
    return lifecycleTombstone(sessionId)
  }
  states.set(sessionId, restored)
  return restored
}

function storedOf(state: SessionState): StoredState {
  return {
    sessionId: state.sessionId,
    workspace: state.workspace,
    generation: state.generation,
    instructionGeneration: state.instructionGeneration,
    permissionGeneration: state.permissionGeneration,
    planMode: state.planMode,
    nextOwnerId: state.nextOwnerId,
    ownerMessages: state.ownerMessages,
    agentTasks: state.agentTasks,
    history: state.history,
    contextGap: state.contextGap,
    closed: state.closed,
    touchedAt: state.touchedAt,
  }
}

function enforceCaps(state: SessionState) {
  while (
    state.ownerMessages.length > MAX_OWNER_MESSAGES ||
    textBytes(state.ownerMessages) > MAX_OWNER_BYTES
  ) {
    state.ownerMessages.shift()
    state.contextGap = true
  }
  while (
    state.history.length > MAX_HISTORY ||
    textBytes(state.history) > MAX_HISTORY_BYTES
  ) {
    state.history.shift()
  }
  while (textBytes(storedOf(state)) > MAX_SESSION_BYTES && state.history.length) {
    state.history.shift()
  }
  while (textBytes(storedOf(state)) > MAX_SESSION_BYTES && state.ownerMessages.length) {
    state.ownerMessages.shift()
    state.contextGap = true
  }
  if (textBytes(storedOf(state)) > MAX_SESSION_BYTES) {
    throw new Error('session state exceeds its storage cap')
  }
}

async function writeState($: EngineInterface, state: SessionState) {
  enforceCaps(state)
  state.touchedAt = await $.clock.now()
  const stored = storedOf(state)
  const size = textBytes(stored)
  const raw = await $.store.get(indexKey(state.workspace))
  if (
    raw !== undefined &&
    (!Array.isArray(raw) ||
      new Set(raw.map(item => isRecord(item) ? item.sessionId : undefined)).size !== raw.length ||
      raw.some(
        item =>
          !isRecord(item) ||
          typeof item.sessionId !== 'string' ||
          typeof item.closed !== 'boolean' ||
          !isNumber(item.touchedAt) ||
          !isNumber(item.bytes) ||
          !Number.isInteger(item.bytes),
      ))
  ) {
    throw new Error('plugin store index is invalid')
  }
  const index = (raw ?? []) as StoreIndexEntry[]
  const next = index.filter(item => item.sessionId !== state.sessionId)
  next.push({
    sessionId: state.sessionId,
    closed: state.closed,
    touchedAt: state.touchedAt,
    bytes: size,
  })
  next.sort((a, b) => b.touchedAt - a.touchedAt)

  const removed: StoreIndexEntry[] = []
  while (
    next.length > MAX_STORED_SESSIONS ||
    next.reduce((sum, item) => sum + item.bytes, 0) > MAX_STORE_BYTES
  ) {
    const position = next.findLastIndex(
      item => item.closed && item.sessionId !== state.sessionId,
    )
    const fallback = next.findLastIndex(item => item.sessionId !== state.sessionId)
    if (position < 0 && fallback < 0) throw new Error('plugin store cap cannot be met safely')
    removed.push(...next.splice(position < 0 ? fallback : position, 1))
  }
  await $.store.set(storeKey(state.workspace, state.sessionId), stored)
  await $.store.set(indexKey(state.workspace), next)
  for (const entry of removed) await $.store.delete(storeKey(state.workspace, entry.sessionId))
}

async function saveState($: EngineInterface, state: SessionState) {
  if (state.storeLoadFailed) throw new Error('session state could not be loaded')
  const write = state.write.then(() => {
    const run = storeWrite.then(() => writeState($, state))
    storeWrite = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  })
  state.write = write.catch(() => undefined)
  return write
}

function invalidateState(
  $: EngineInterface,
  state: SessionState,
  kind: string,
) {
  state.integrityInvalid = true
  state.availability = 'unavailable'
  bestEffortStatus(
    $,
    `approval reviewer unavailable — all asks deny (${sanitize(kind, 48)})`,
  )
}

function invalidateAll($: EngineInterface, kind = 'context-integrity') {
  globallyInvalid = true
  for (const state of states.values()) {
    state.integrityInvalid = true
    state.availability = 'unavailable'
  }
  bestEffortStatus(
    $,
    `approval reviewer unavailable — all asks deny (${sanitize(kind, 48)})`,
  )
}

function appendOwner(state: SessionState, original: string, transformed?: string) {
  state.ownerMessages.push({
    id: `u${state.nextOwnerId++}`,
    original,
    ...(transformed !== original && { transformed }),
    at: state.touchedAt,
  })
  enforceCaps(state)
}

function appendHistory(state: SessionState, entry: HistoryEntry) {
  const index = state.history.findIndex(item => item.requestId === entry.requestId)
  if (index < 0) state.history.push(entry)
  else state.history[index] = entry
  enforceCaps(state)
}

function toolInput(e: Record<string, unknown>) {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) {
    if (!['tool', 'tool_use_id', 'agentId', 'consent'].includes(key)) input[key] = value
  }
  return input
}

function coreAsk(trace: readonly unknown[]) {
  return trace.some(item => {
    if (typeof item !== 'object' || item === null) return false
    const entry = item as Record<string, unknown>
    const returned = entry.returned as Record<string, unknown> | undefined
    return (
      entry.plugin === 'engine' &&
      entry.tier === 'core' &&
      entry.event === 'tool.check' &&
      entry.outcome === 'returned' &&
      returned?.decision === 'ask'
    )
  })
}

const operationalReason = (kind: string) =>
  sanitize(`Approval reviewer unavailable (${kind}); this request was denied.`)

export function bestEffortStatus($: EngineInterface, text: string) {
  try {
    $.ui.status(text)
  } catch {
    // Status reporting must not replace the fail-closed decision.
  }
}

const failureKind = (error: unknown) => {
  if (error instanceof ReviewFailure) {
    if (error.kind === 'protocol') return `review-output:${error.code}`
    if (error.kind === 'stale') return 'stale-result'
    if (error.kind === 'model') return 'model'
    if (error.kind === 'evidence') return 'evidence'
  }
  const message = error instanceof Error ? error.message : 'review failed'
  if (message === 'review became stale') return 'stale-result'
  if (
    message.startsWith('review output') ||
    message.startsWith('invalid ') ||
    message.startsWith('evidence request') ||
    message.startsWith('second evidence')
  ) {
    return 'invalid-assessment'
  }
  return 'hook'
}

function unavailable($: EngineInterface, state: SessionState, kind: string) {
  state.availability = 'unavailable'
  bestEffortStatus(
    $,
    `approval reviewer unavailable — model-reviewed asks deny (${sanitize(kind, 48)})`,
  )
}

function historyText(state: SessionState) {
  if (state.history.length === 0) return 'No approval-reviewer decisions in this session.'
  return state.history
    .slice(-20)
    .map(item => {
      const assessment = item.risk
        ? `; risk=${item.risk}; authorization=${item.authorization}; evidence=${
            item.evidenceIds?.join(',') || 'none'
          }`
        : ''
      const attempts = item.attempts === undefined ? '' : `; attempts=${item.attempts}`
      return (
        `${item.verdict.toUpperCase()} ${item.action} — ${item.reason} ` +
        `(${item.elapsedMs}ms${attempts}${assessment}${
          item.failureKind ? `; failure=${item.failureKind}` : ''
        })`
      )
    })
    .join('\n')
}

export const register: Register = (on, options) => {
  const model = selectedModel(options.model)

  on('session.start', async ($, e, next) => {
    const sessionId = await $.session.id()
    sessionWorkspaces.set(sessionId, e.cwd)
    const epoch = beginLifecycle(sessionId)
    const state = await startingStateFor($, sessionId, epoch, e.cwd)
    const isCurrentStart = () =>
      lifecycleIsCurrent(sessionId, epoch) && states.get(sessionId) === state && !state.closed
    if (!isCurrentStart()) return next(e)
    const messages = await $.session.messages()
    if (!isCurrentStart()) return next(e)
    const transcriptOwners = messages.filter(
      (message: SessionMessage) => message.role === 'user',
    )
    const retainedTail = state.ownerMessages.slice(-transcriptOwners.length)
    const transcriptMismatch = transcriptOwners.some((message, index) => {
      const retained = retainedTail[index]
      return (
        retained === undefined ||
        (message.text !== retained.original && message.text !== retained.transformed)
      )
    })
    if (
      transcriptOwners.length > state.ownerMessages.length ||
      transcriptMismatch
    ) {
      state.contextGap = true
    }
    state.availability = 'checking'
    if (!isCurrentStart()) return next(e)
    await $.ui.status('approval reviewer checking')
    if (!isCurrentStart()) return next(e)
    await $.command.register({
      name: 'approval-history',
      description: 'Show recent automatic permission decisions',
    })
    if (!isCurrentStart()) return next(e)

    if (globallyInvalid || state.integrityInvalid || state.contextGap) {
      state.availability = 'unavailable'
      if (!isCurrentStart()) return next(e)
      await $.ui.status(
        `approval reviewer unavailable — model-reviewed asks deny${
          state.storeLoadFailed ? ' (store)' : ''
        }`,
      )
      if (!isCurrentStart()) return next(e)
      if (!state.storeLoadFailed) {
        try {
          await saveState($, state)
        } catch {
          bestEffortStatus($, 'approval reviewer unavailable — history store unavailable (store)')
        }
      }
      return next(e)
    }

    const check = await raceDeadline(
      (ms, fn) => $.clock.after(ms, fn),
      $.model
        .complete({ model, prompt: 'Reply with ok.', maxTokens: 8 })
        .then(result => ({ ok: result.isAnswered && result.text.trim().length > 0 }))
        .catch(() => ({ ok: false })),
      10_000,
    )
    if (!isCurrentStart()) return next(e)
    state.availability = !check.timedOut && check.value.ok ? 'active' : 'unavailable'
    if (!isCurrentStart()) return next(e)
    await $.ui.status(
      state.availability === 'active'
        ? 'approval reviewer active'
        : 'approval reviewer unavailable — model-reviewed asks deny',
    )
    if (!isCurrentStart()) return next(e)
    try {
      await saveState($, state)
    } catch {
      bestEffortStatus($, `approval reviewer ${state.availability} — history store unavailable (store)`)
    }
    return next(e)
  }).catch(($, e, next) => {
    invalidateAll($)
    return next(e)
  })

  on('command.run', { command: 'approval-history' }, async ($, e) => {
    const sessionId = await $.session.id()
    const state = await stateFor($, sessionId)
    return { text: historyText(state) }
  }).catch(() => ({ text: 'Approval history is unavailable.' }))

  on('prompt.submit', async ($, e, next) => {
    const sessionId = await $.session.id()
    const state = await stateFor($, sessionId)
    const generation = state.generation
    const instructionGeneration =
      e.origin.kind === 'composer'
        ? state.instructionGeneration + 1
        : state.instructionGeneration
    if (e.origin.kind === 'composer') state.instructionGeneration = instructionGeneration
    const result = await next(e)
    if (
      e.origin.kind === 'composer' &&
      'text' in result &&
      states.get(sessionId) === state &&
      !state.closed &&
      state.generation === generation &&
      state.instructionGeneration === instructionGeneration
    ) {
      appendOwner(state, e.text, result.text)
      try {
        await saveState($, state)
      } catch {
        invalidateState($, state, 'store')
      }
    }
    return result
  }).catch(($, e, next) => {
    invalidateAll($)
    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    if (
      e.origin.kind === 'engine' &&
      ['plan_mode', 'plan_mode_exit', 'auto_mode', 'auto_mode_exit'].includes(e.type)
    ) {
      const state = await stateFor($, await $.session.id())
      state.permissionGeneration += 1
      if (e.type === 'plan_mode') state.planMode = true
      if (e.type === 'plan_mode_exit') state.planMode = false
    }
    return next(e)
  }).catch(($, e, next) => {
    invalidateAll($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const sessionId = await $.session.id()
    const state = await stateFor($, sessionId)
    if (state.closed) {
      return { deny: 'Approval reviewer session is closed.' }
    }
    const generation = state.generation
    const result = await next(e)
    if (
      'agentId' in result &&
      result.agentId &&
      states.get(sessionId) === state &&
      !state.closed &&
      state.generation === generation
    ) {
      state.agentTasks.push([result.agentId, e.prompt])
      state.agentTasks = state.agentTasks.slice(-128)
      try {
        await saveState($, state)
      } catch {
        invalidateState($, state, 'store')
      }
    }
    return result
  }).catch($ => {
    invalidateAll($)
    return { deny: 'Approval reviewer could not bind the subagent context.' }
  })

  on('session.end', async ($, e, next) => {
    endLifecycle(e.sessionId)
    const state = states.get(e.sessionId)
    if (state) {
      state.closed = true
      state.generation += 1
      state.instructionGeneration += 1
      for (const call of calls.values()) {
        if (call.sessionId === e.sessionId) call.closed = true
      }
      try {
        await saveState($, state)
      } catch {
        bestEffortStatus($, 'approval reviewer history store unavailable (store)')
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    invalidateAll($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let expire = () => undefined
    const deadline = new Promise<void>(resolve => {
      expire = resolve
    })
    let expired = false
    let record: CallRecord | undefined
    const deadlineTimer = $.clock.after(DEADLINE_MS, () => {
      expired = true
      if (record) {
        record.expired = true
        record.finalFailure = 'deadline'
      }
      expire()
    })
    try {
      const setup = (async () => {
        const startedAt = await $.clock.now()
        const sessionId = await $.session.id()
        const epoch = lifecycleFor(sessionId).epoch
        const state = await stateFor($, sessionId, epoch)
        if (!e.tool_use_id) {
          return { deny: 'Approval reviewer could not identify this call.' } as const
        }
        if (state.closed) {
          return { deny: 'Approval reviewer session is closed.' } as const
        }
        const input = toolInput(e as unknown as Record<string, unknown>)
        const cwd = await $.session.cwd()
        const root = await $.session.root()
        if (
          !lifecycleIsCurrent(sessionId, epoch) ||
          states.get(sessionId) !== state ||
          state.closed
        ) {
          return { deny: 'Approval reviewer session is closed.' } as const
        }
        const key = `${sessionId}:${e.tool_use_id}`
        if (calls.has(key)) {
          return {
            deny: 'Approval reviewer found an ambiguous call identity.',
          } as const
        }
        const action = { tool: e.tool, input, cwd, root }
        return {
          record: {
            key,
            sessionId,
            toolUseId: e.tool_use_id,
            tool: e.tool,
            input,
            agentId: e.agentId,
            cwd,
            root,
            startedAt,
            actionCanonical: canonical(action),
            actionFingerprint: fingerprint(action),
            deadline,
            deadlineTimer,
            expired,
            generation: state.generation,
            closed: false,
          } satisfies CallRecord,
        } as const
      })()
      const prepared = await Promise.race([
        setup.then(value => ({ timedOut: false as const, value })),
        deadline.then(() => ({ timedOut: true as const })),
      ])
      if (prepared.timedOut) {
        return { deny: 'Approval reviewer deadline expired.' }
      }
      if ('deny' in prepared.value) return prepared.value
      record = prepared.value.record
      if (record.expired) return { deny: 'Approval reviewer deadline expired.' }
      const currentState = states.get(record.sessionId)
      if (
        calls.has(record.key) ||
        currentState === undefined ||
        currentState.generation !== record.generation ||
        currentState.closed
      ) {
        return {
          deny: 'Approval reviewer found an ambiguous call identity.',
        }
      }
      calls.set(record.key, record)
      return await next(e)
    } finally {
      deadlineTimer.cancel()
      if (record) {
        record.closed = true
        if (calls.get(record.key) === record) calls.delete(record.key)
      }
    }
  }).catch($ => {
    invalidateAll($)
    return { deny: 'Approval reviewer observer failed closed.' }
  })

  on('tool.check', async ($, e, next) => {
    const downstream = await next(e)
    if (downstream.decision !== 'ask') return downstream

    let currentSessionId: string
    try {
      currentSessionId = await $.session.id()
    } catch {
      invalidateAll($)
      return {
        decision: 'deny' as const,
        reason: operationalReason('context-integrity'),
      }
    }
    const matching = [...calls.values()].filter(
      call =>
        call.sessionId === currentSessionId &&
        !call.closed &&
        call.toolUseId === e.tool_use_id &&
        call.tool === e.tool,
    )
    const deadlineCall = matching.length === 1 ? matching[0] : undefined
    const immediateDeny = (kind: string, reason?: string) => {
      const safeReason =
        sanitize(reason ?? operationalReason(kind)) ||
        'Approval reviewer failed closed.'
      if (deadlineCall) {
        const state = states.get(deadlineCall.sessionId)
        if (
          state &&
          states.get(deadlineCall.sessionId) === state &&
          calls.get(deadlineCall.key) === deadlineCall &&
          !state.closed &&
          state.generation === deadlineCall.generation
        ) {
          appendHistory(state, {
            requestId: deadlineCall.toolUseId,
            fingerprint: deadlineCall.actionFingerprint,
            action: `${sanitize(deadlineCall.tool, 64)} request`,
            verdict: 'deny',
            reason: safeReason,
            elapsedMs: 0,
            at: deadlineCall.startedAt,
            failureKind: kind,
          })
          void saveState($, state).catch(() => {
            invalidateState($, state, 'store')
          })
        }
      }
      return { decision: 'deny' as const, reason: safeReason }
    }

    if (e.tool === 'ExitPlanMode') {
      return immediateDeny(
        'plan-transition',
        'Approval reviewer does not approve leaving Plan mode.',
      )
    }
    if (!deadlineCall) return immediateDeny('context-integrity')

    const handling = (async () => {
      const sessionId = currentSessionId
      const state = await stateFor($, sessionId)
      const call = deadlineCall
      const now = await $.clock.now()
      const fail = async (kind: string, reason?: string, attempts?: number) => {
        const effectiveKind = call?.finalFailure ?? kind
        const safeReason =
          sanitize(reason ?? operationalReason(effectiveKind)) ||
          'Approval reviewer failed closed.'
        if (
          states.get(sessionId) !== state ||
          state.closed ||
          state.generation !== call.generation
        ) {
          return { decision: 'deny' as const, reason: safeReason }
        }
        const validAttempts =
          typeof attempts === 'number' &&
          Number.isInteger(attempts) &&
          attempts >= 1 &&
          attempts <= 3
            ? attempts
            : undefined
        try {
          const failedAt = await $.clock.now()
          const requestId = e.tool_use_id ?? `query-${now}`
          appendHistory(state, {
            requestId,
            fingerprint: call?.actionFingerprint ?? 'unknown',
            action: `${sanitize(e.tool, 64)} request`,
            verdict: 'deny',
            reason: safeReason,
            elapsedMs: Math.max(0, failedAt - (call?.startedAt ?? failedAt)),
            at: failedAt,
            ...(validAttempts !== undefined && { attempts: validAttempts }),
            failureKind: effectiveKind,
          })
          await saveState($, state)
        } catch {
          invalidateState($, state, 'store')
        }
        return { decision: 'deny' as const, reason: safeReason }
      }

    if (
      globallyInvalid ||
      state.integrityInvalid ||
      state.contextGap ||
      !e.tool_use_id ||
      call.sessionId !== sessionId ||
      state.sessionId !== call.sessionId ||
      states.get(call.sessionId) !== state ||
      calls.get(call.key) !== call ||
      call.closed ||
      state.closed ||
      call.generation !== state.generation ||
      call.tool !== e.tool ||
      call.actionCanonical !==
        canonical({ tool: e.tool, input: e.input, cwd: call.cwd, root: call.root }) ||
      next.origin.plugin !== 'engine' ||
      next.origin.tier !== 'core' ||
      !coreAsk(next.trace)
    ) {
      return fail('context-integrity')
    }

    const generation = state.generation
    const instructionGeneration = state.instructionGeneration
    const permissionGeneration = state.permissionGeneration
    const isFresh = () =>
      !call.closed &&
      calls.get(call.key) === call &&
      !next.signal.aborted &&
      !globallyInvalid &&
      !state.integrityInvalid &&
      !state.closed &&
      state.generation === generation &&
      call.generation === generation &&
      state.instructionGeneration === instructionGeneration &&
      state.permissionGeneration === permissionGeneration

    const work = (async () => {
      if (call.expired) return fail('deadline')
      if (!state.planMode) {
        const workspaceTarget = await classifyWorkspaceMutation(
          {
            stat: (path, statOptions) => $.fs.stat(path, statOptions),
            list: path => $.fs.list(path),
          },
          {
            tool: e.tool,
            input: e.input,
            cwd: call.cwd,
            root: call.root,
          },
        )
        if (workspaceTarget !== undefined) {
          const finishedAt = await $.clock.now()
          if (!isFresh() || finishedAt - call.startedAt >= DEADLINE_MS) {
            return fail(
              call.expired || finishedAt - call.startedAt >= DEADLINE_MS
                ? 'deadline'
                : 'stale-result',
            )
          }
          const entry: HistoryEntry = {
            requestId: call.toolUseId,
            fingerprint: call.actionFingerprint,
            action: `${sanitize(call.tool, 64)} request`,
            verdict: 'allow',
            reason: `Workspace-local ${sanitize(call.tool, 32)} allowed without model review.`,
            elapsedMs: Math.max(0, finishedAt - call.startedAt),
            at: finishedAt,
          }
          appendHistory(state, entry)
          try {
            await saveState($, state)
          } catch {
            const storeReason = operationalReason('store')
            Object.assign(entry, {
              verdict: 'deny' as const,
              reason: storeReason,
              failureKind: 'store',
            })
            invalidateState($, state, 'store')
            return { decision: 'deny' as const, reason: storeReason }
          }
          const releasedAt = await $.clock.now()
          if (!isFresh() || releasedAt - call.startedAt >= DEADLINE_MS) {
            const kind =
              call.finalFailure ??
              (call.expired || releasedAt - call.startedAt >= DEADLINE_MS
                ? 'deadline'
                : 'stale-result')
            return fail(kind)
          }
          return { decision: 'allow' as const }
        }
      }
      state.availability = 'checking'
      await $.ui.status('approval reviewer checking')
      const transcript = await $.session.messages()
      if (!isFresh()) return fail(call.expired ? 'deadline' : 'stale-result')
      const task = state.agentTasks.find(([id]) => id === call.agentId)?.[1]

      let review: ReviewResult
      try {
        review = await reviewPending(
          {
            complete: request => $.model.complete(request),
            stat: (path, statOptions) => $.fs.stat(path, statOptions),
            list: path => $.fs.list(path),
            read: path => $.fs.read(path),
          },
          {
            model,
            requestId: call.toolUseId,
            sessionId,
            agentId: call.agentId,
            agentTask: task,
            tool: e.tool,
            input: e.input,
            cwd: call.cwd,
            root: call.root,
            planMode: state.planMode,
            ownerMessages: state.ownerMessages,
            transcript,
            isFresh,
          },
        )
      } catch (error) {
        const kind = failureKind(error)
        if (
          states.get(sessionId) === state &&
          !state.closed &&
          state.generation === call.generation
        ) {
          unavailable($, state, kind)
        }
        return fail(
          kind,
          undefined,
          error instanceof ReviewFailure ? error.attempts : undefined,
        )
      }
      if (!isFresh()) return fail(call.expired ? 'deadline' : 'stale-result')

      state.availability = 'active'
      await $.ui.status('approval reviewer active')
      const finishedAt = await $.clock.now()
      if (!isFresh() || finishedAt - call.startedAt >= DEADLINE_MS) {
        return fail(
          call.expired || finishedAt - call.startedAt >= DEADLINE_MS
            ? 'deadline'
            : 'stale-result',
        )
      }

      const reason = sanitize(review.reason || (review.allow ? 'Allowed.' : 'Denied.'))
      const entry: HistoryEntry = {
        requestId: call.toolUseId,
        fingerprint: call.actionFingerprint,
        action: `${sanitize(call.tool, 64)} request`,
        verdict: review.allow ? 'allow' : 'deny',
        reason,
        elapsedMs: Math.max(0, finishedAt - call.startedAt),
        at: finishedAt,
        attempts: review.attempts,
        risk: review.assessment.risk,
        authorization: review.assessment.authorization,
        evidenceIds: review.assessment.evidenceIds,
      }
      appendHistory(state, entry)
      try {
        await saveState($, state)
      } catch {
        const storeReason = operationalReason('store')
        Object.assign(entry, {
          verdict: 'deny' as const,
          reason: storeReason,
          risk: undefined,
          authorization: undefined,
          evidenceIds: undefined,
          failureKind: 'store',
        })
        invalidateState($, state, 'store')
        return { decision: 'deny' as const, reason: storeReason }
      }

      const releasedAt = await $.clock.now()
      if (!isFresh() || releasedAt - call.startedAt >= DEADLINE_MS) {
        const kind =
          call.finalFailure ??
          (call.expired || releasedAt - call.startedAt >= DEADLINE_MS
            ? 'deadline'
            : 'stale-result')
        return fail(kind, undefined, review.attempts)
      }
      return review.allow
        ? { decision: 'allow' as const }
        : { decision: 'deny' as const, reason }
    })().catch(async () => {
      if (
        states.get(sessionId) === state &&
        !state.closed &&
        state.generation === call.generation
      ) {
        unavailable($, state, 'hook')
      }
      return fail('hook')
    })

    const settled = await Promise.race([
      work.then(value => ({ timedOut: false as const, value })),
      call.deadline.then(() => ({ timedOut: true as const })),
    ])
    if (settled.timedOut) {
      call.finalFailure = 'deadline'
      call.closed = true
      if (
        states.get(sessionId) === state &&
        !state.closed &&
        state.generation === call.generation
      ) {
        state.availability = 'unavailable'
        bestEffortStatus($, 'approval reviewer unavailable — model-reviewed asks deny (deadline)')
      }
      void fail('deadline')
      return { decision: 'deny', reason: operationalReason('deadline') }
    }
    return settled.value
    })()

    const guarded = await Promise.race([
      handling.then(value => ({ timedOut: false as const, value })),
      deadlineCall.deadline.then(() => ({ timedOut: true as const })),
    ])
    if (guarded.timedOut) {
      deadlineCall.finalFailure = 'deadline'
      deadlineCall.closed = true
      const state = states.get(deadlineCall.sessionId)
      if (
        state &&
        !state.closed &&
        state.generation === deadlineCall.generation
      ) {
        state.availability = 'unavailable'
        bestEffortStatus($, 'approval reviewer unavailable — model-reviewed asks deny (deadline)')
      }
      return immediateDeny('deadline')
    }
    return guarded.value
  }).catch(($, e) => {
    invalidateAll($)
    void (async () => {
      try {
        const sessionId = await $.session.id()
        const matching = [...calls.values()].filter(
          call =>
            call.sessionId === sessionId &&
            !call.closed &&
            call.toolUseId === e.tool_use_id &&
            call.tool === e.tool,
        )
        const call = matching.length === 1 ? matching[0] : undefined
        if (call) {
          const state = states.get(call.sessionId)
          if (
            state &&
            calls.get(call.key) === call &&
            !state.closed &&
            state.generation === call.generation
          ) {
            state.availability = 'unavailable'
            appendHistory(state, {
              requestId: call.toolUseId,
              fingerprint: call.actionFingerprint,
              action: `${sanitize(call.tool, 64)} request`,
              verdict: 'deny',
              reason: 'Approval reviewer failed closed.',
              elapsedMs: 0,
              at: call.startedAt,
              failureKind: 'hook',
            })
            await saveState($, state)
          }
        }
      } catch {
        // Local history must never delay or replace the constant deny.
      }
    })()
    return {
      decision: 'deny',
      reason: 'Approval reviewer failed closed.',
    }
  })
}
