import type { EngineInterface, Register, SessionMessage, Timer } from 'claude-code'
import { canonical, reviewPending, sanitize, ReviewFailure, MAX_COMPLETIONS,
  type OwnerMessage, type ReviewBudget, type ReviewResult } from './reviewer.ts'
import { classifyWorkspaceMutation } from './workspace.ts'

const DEADLINE_MS = 90_000
const MAX_HISTORY = 20
export const DEFAULT_MODEL = 'sonnet'
export const selectedModel = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_MODEL

type Verdict = { decision: 'allow' | 'deny'; reason?: string }
type HistoryEntry = {
  tool: string
  verdict: 'allow' | 'deny'
  reason: string
  attempts: number
  kind: 'workspace' | 'assessment' | 'unavailable'
}
type SessionState = {
  revision: number
  owners: OwnerMessage[]
  modes: Map<string, { plan: boolean }>
  history: HistoryEntry[]
  reviews: Map<string, Promise<Verdict>>
  admissions: Set<Promise<void>>
}

export function bestEffortStatus($: EngineInterface, text: string) {
  try { $.ui.status(text) } catch {}
}

const unavailableReason = (kind: string) =>
  `Permission review could not complete (${kind}); this is not a safety judgment. ` +
  'This action was not run. Report this action as blocked and continue independent work. ' +
  'Do not split it into equivalent commands or repeat it to bypass review. ' +
  'The owner can resolve the review failure or explicitly approve the action through native permissions.'

function hasCoreResult(
  trace: readonly unknown[],
  event: string,
  matches: (result: Record<string, unknown> | undefined) => boolean,
) {
  return trace.some(value => {
    if (typeof value !== 'object' || value === null) return false
    const entry = value as Record<string, unknown>
    const returned = entry.returned as Record<string, unknown> | undefined
    return entry.plugin === 'engine' && entry.tier === 'core' &&
      entry.event === event && entry.outcome === 'returned' && matches(returned)
  })
}

function shouldReview(
  e: { tool: string; tool_use_id?: string; ceiling?: unknown },
  result: { decision: string; rule?: unknown; hook?: unknown; ceiling?: unknown },
  next: { origin: { plugin: string; tier: string }; trace: readonly unknown[] },
) {
  return result.decision === 'ask' && result.rule === undefined && result.hook === undefined &&
    result.ceiling !== 'ask' && e.ceiling !== 'ask' && !!e.tool_use_id &&
    !['AskUserQuestion', 'ExitPlanMode'].includes(e.tool) &&
    next.origin.plugin === 'engine' && next.origin.tier === 'core' &&
    hasCoreResult(next.trace, 'tool.check', result => result?.decision === 'ask' &&
      result.rule === undefined && result.hook === undefined && result.ceiling !== 'ask')
}

export const register: Register = (on, options) => {
  const states = new Map<string, SessionState>()
  const attributions = new Set<Promise<void>>()
  let submission = 0
  let attributionFailures = 0
  const model = selectedModel(options.model)
  const stateFor = (id: string) => {
    let state = states.get(id)
    if (!state) {
      state = { revision: 0, owners: [], modes: new Map(),
        history: [], reviews: new Map(), admissions: new Set() }
      states.set(id, state)
    }
    return state
  }
  const remember = (state: SessionState, entry: HistoryEntry) => {
    state.history.push(entry)
    state.history = state.history.slice(-MAX_HISTORY)
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'approval-history', description: 'Show recent permission reviews' })
    } catch {}
    bestEffortStatus($, 'approval reviewer active')
    return next(e)
  })

  on('command.run', { command: 'approval-history' }, async $ => {
    const history = stateFor(await $.session.id()).history
    return { text: history.length ? history.map(entry =>
      `${entry.verdict.toUpperCase()} ${sanitize(entry.tool, 64)} (${entry.kind}; attempts=${entry.attempts}) — ${entry.reason}`,
    ).join('\n') : 'No approval-reviewer decisions in this session. History is kept until this session ends.' }
  }).catch(() => ({ text: 'Approval history could not be displayed.' }))

  on('prompt.submit', async ($, e, next) => {
    if (!['composer', 'bridge', 'sdk'].includes(e.origin.kind)) return next(e)
    // Order and original words are captured before any host call can yield.
    const message: OwnerMessage = { id: `u${++submission}`, original: e.text, at: Date.now() }
    let release!: () => void
    const admitted = new Promise<void>(resolve => { release = resolve })
    let attributed!: () => void
    const attribution = new Promise<void>(resolve => { attributed = resolve })
    attributions.add(attribution)
    let state: SessionState | undefined
    try {
      try { state = stateFor(await $.session.id()) } catch {
        attributionFailures += 1
        return { drop: 'Approval reviewer could not identify this session to capture your instruction. Resubmit this prompt; it was not sent.' }
      }
      state.admissions.add(admitted)
      state.revision += 1
      attributions.delete(attribution)
      attributed()
      const result = await next(e)
      if (!('drop' in result && result.drop !== undefined) &&
          hasCoreResult(next.trace, 'prompt.submit', result => typeof result?.text === 'string')) {
        if (message.original.length > 48_000) {
          message.original = message.original.slice(0, 24_000) + '\n[owner text omitted]\n' + message.original.slice(-24_000)
          message.complete = false
        }
        state.owners.push(message)
        state.owners.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        state.owners = state.owners.slice(-256)
        state.revision += 1
      }
      return result
    } finally {
      attributions.delete(attribution)
      attributed()
      if (state) {
        state.revision += 1
        state.admissions.delete(admitted)
      }
      release()
    }
  })

  on('prompt.attachment', async ($, e, next) => {
    // ponytail: a failed lookup throws, so the host skips this hook, runs core and reports it.
    // A missed entry leaves Plan unenforced until the next reminder; a missed exit keeps it
    // enforced until Plan mode is entered and exited again. Track failures if this is observed.
    if (e.origin.kind === 'engine' && ['plan_mode', 'plan_mode_exit'].includes(e.type)) {
      const state = stateFor(await $.session.id())
      const loop = e.agentId ?? 'main'
      const plan = e.type === 'plan_mode'
      if (state.modes.get(loop)?.plan !== plan) state.modes.set(loop, { plan })
    }
    return next(e)
  })

  on('session.end', (_$, e, next) => {
    states.delete(e.sessionId)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const state = stateFor(await $.session.id())
    const result = await next(e)
    if ('agentId' in result && typeof result.agentId === 'string' && e.permissionMode &&
        hasCoreResult(next.trace, 'agent.spawn', value => value?.agentId === result.agentId) &&
        !state.modes.has(result.agentId)) {
      state.modes.set(result.agentId, { plan: e.permissionMode === 'plan' })
    }
    return result
  })

  on('tool.check', async ($, e, next) => {
    const downstream = await next(e)
    if (!shouldReview(e, downstream, next)) return downstream

    let state: SessionState | undefined
    let expired = false
    const failures = attributionFailures
    let timer: Timer | undefined
    const budget: ReviewBudget = { deadline: 0, attempts: 0, evidenceRounds: 0 }
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = $.clock.after(DEADLINE_MS, () => {
          expired = true
          reject(new ReviewFailure('deadline', 'review-deadline', budget.attempts, '90-second review deadline reached'))
        })
      })
      const decide = async (): Promise<Verdict> => {
        const sessionId = await $.session.id()
        state = stateFor(sessionId)
        const currentState = state
        const agentId = 'agentId' in e && typeof e.agentId === 'string' ? e.agentId : undefined
        // A child's own mode attachment can arrive after its first native tool call.
        const permissionMode = () => currentState.modes.get(agentId ?? 'main') ?? currentState.modes.get('main')
        const key = `${e.tool_use_id}\0${agentId ?? ''}\0${canonical({ tool: e.tool, input: e.input })}`
        const previous = state.reviews.get(key)
        if (previous) {
          const verdict = await previous
          if (expired || attributionFailures !== failures || next.signal.aborted || states.get(sessionId) !== currentState) {
            throw new ReviewFailure(next.signal.aborted ? 'cancelled' : 'stale',
              next.signal.aborted ? 'review-cancelled' : 'review-stale', budget.attempts, 'waiting review is no longer active')
          }
          return verdict
        }

        const run = async (): Promise<Verdict> => {
          budget.deadline = await $.clock.now() + DEADLINE_MS
          const active = () => !expired && attributionFailures === failures && states.get(sessionId) === currentState && !next.signal.aborted
          while (active()) {
            await Promise.all([...attributions, ...currentState.admissions])
            const revision = currentState.revision
            const mode = permissionMode()
            const fresh = () => active() && attributions.size === 0 && currentState.admissions.size === 0 &&
              currentState.revision === revision && permissionMode() === mode
            const [cwd, root] = await Promise.all([$.session.cwd(), $.session.root()])
            const planMode = mode?.plan ?? false
            if (!planMode) {
              const target = await classifyWorkspaceMutation({
                stat: (path, statOptions) => $.fs.stat(path, statOptions), list: path => $.fs.list(path),
              }, { tool: e.tool, input: e.input, cwd, root })
              const now = await $.clock.now()
              if (target && now < budget.deadline && fresh()) {
                const [currentCwd, currentRoot] = await Promise.all([$.session.cwd(), $.session.root()])
                if (!fresh() || currentCwd !== cwd || currentRoot !== root) continue
                remember(currentState, { tool: e.tool, verdict: 'allow', kind: 'workspace',
                  reason: 'Verified workspace edit.', attempts: 0 })
                return { decision: 'allow' }
              }
            }
            bestEffortStatus($, 'approval reviewer checking')
            let transcript: SessionMessage[] = []
            let agentTranscript: SessionMessage[] | undefined
            const contextNotes: string[] = []
            try { transcript = await $.session.messages() } catch { contextNotes.push('Main transcript unavailable.') }
            if (agentId) {
              try {
                const found = await $.session.messages({ agentId })
                if ('deny' in found) contextNotes.push('Agent transcript unavailable.')
                else agentTranscript = found
              } catch { contextNotes.push('Agent transcript unavailable.') }
            }
            let result: ReviewResult
            try {
              result = await reviewPending({
                now: () => $.clock.now(), cancelled: () => next.signal.aborted,
                sleep: ms => $.clock.sleep(ms, { signal: next.signal }),
                complete: request => $.model.complete(request),
                stat: (path, statOptions) => $.fs.stat(path, statOptions),
                list: path => $.fs.list(path),
                read: async path => {
                  // A permission query skips classic hooks. The real Read must run them.
                  const result = await $.tool.call({ tool: 'Read', file_path: path })
                  if (result.deny !== undefined || result.isError) throw new Error('native Read denied')
                  const value = result.result as { type?: unknown; file?: { content?: unknown } }
                  if (value?.type !== 'text' || typeof value.file?.content !== 'string') {
                    throw new Error('native Read did not return file text')
                  }
                  return value.file.content
                },
                canRead: async path => (await $.tool.check({ tool: 'Read', input: { file_path: path } })).decision === 'allow',
              }, { model, requestId: e.tool_use_id!, sessionId, agentId, tool: e.tool,
                input: e.input, cwd, root, planMode, ownerMessages: [...currentState.owners],
                transcript, agentTranscript, contextNotes, budget, isFresh: fresh })
            } catch (error) {
              if (error instanceof ReviewFailure && error.kind === 'stale' && active() && budget.attempts < MAX_COMPLETIONS) continue
              throw error
            }
            if (!fresh()) {
              if (active() && budget.attempts < MAX_COMPLETIONS) continue
              throw new ReviewFailure('stale', 'review-stale', budget.attempts, 'instructions changed during review')
            }
            if (result.allow) {
              const [currentCwd, currentRoot] = await Promise.all([$.session.cwd(), $.session.root()])
              if (!fresh() || currentCwd !== cwd || currentRoot !== root) {
                if (active() && budget.attempts < MAX_COMPLETIONS) continue
                throw new ReviewFailure('stale', 'review-stale', budget.attempts, 'working scope changed during review')
              }
            }
            const reason = sanitize(result.reason)
            remember(currentState, { tool: e.tool, verdict: result.allow ? 'allow' : 'deny',
              kind: 'assessment', reason, attempts: result.attempts })
            bestEffortStatus($, 'approval reviewer active')
            return result.allow ? { decision: 'allow' } : { decision: 'deny', reason:
              `${reason} This action was not run. Follow the stated safer alternative or ask the owner for the specific authorization needed; do not retry an equivalent action unless the owner authorizes it.` }
          }
          throw new ReviewFailure('stale', 'review-stale', budget.attempts, 'instructions kept changing during review')
        }
        const pending = run()
        state.reviews.set(key, pending)
        try { return await pending } finally {
          if (state.reviews.get(key) === pending) state.reviews.delete(key)
        }
      }
      return await Promise.race([decide(), timeout])
    } catch (error) {
      const kind = error instanceof ReviewFailure ? error.kind : 'hook'
      const detail = error instanceof ReviewFailure ? error.message
        : `hook: ${error instanceof Error ? error.message : typeof error}`
      // Splitting is the remedy for an oversized request, so skip the generic "do not split" text.
      const reason = error instanceof ReviewFailure && error.code === 'prompt-too-large'
        ? error.message : unavailableReason(sanitize(detail, 160))
      if (state) remember(state, { tool: e.tool, verdict: 'deny', kind: 'unavailable', reason,
        attempts: error instanceof ReviewFailure ? error.attempts : 0 })
      bestEffortStatus($, `approval reviewer active — last review unavailable (${kind})`)
      return { decision: 'deny', reason }
    } finally {
      try { timer?.cancel() } catch {}
    }
  }).catch(async ($, e, next) => {
    // Catch's next is replay-safe under the function-hook API; preserve the native boundary.
    const downstream = await next(e)
    if (!shouldReview(e, downstream, next)) return downstream
    bestEffortStatus($, 'approval reviewer active — last review unavailable (hook)')
    return { decision: 'deny', reason: unavailableReason('hook') }
  })
}
