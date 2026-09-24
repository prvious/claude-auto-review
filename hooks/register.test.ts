import { expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}
const answeredOk = { isAnswered: true, text: 'ok', usage }
const scopedSessionKey = (workspace: string, sessionId: string) =>
  `session:${encodeURIComponent(workspace)}:${sessionId}`
const scopedIndexKey = (workspace: string) =>
  `session-index:${encodeURIComponent(workspace)}`

test('startup capability check uses the sonnet alias', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let request: Record<string, unknown> | undefined
  on('session.id', () => ({ value: 'session-startup-sonnet' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_core, event) => {
    request = event
    return { value: answeredOk }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(request?.model).toBe('sonnet')
  expect(request?.effort).toBeUndefined()
  expect(request?.thinking).toBeUndefined()
})

test('trims previously stored decision history without rejecting the session', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-history-trim'
  const key = scopedSessionKey('/work', sessionId)
  const store = new Map<string, unknown>([
    [key, {
      sessionId,
      workspace: '/work',
      generation: 1,
      instructionGeneration: 0,
      permissionGeneration: 0,
      planMode: false,
      nextOwnerId: 1,
      ownerMessages: [],
      agentTasks: [],
      history: Array.from({ length: 25 }, (_, index) => ({
        requestId: `request-${index}`,
        fingerprint: `fingerprint-${index}`,
        action: 'Example request',
        verdict: 'allow',
        reason: 'allowed',
        elapsedMs: 0,
        at: index,
      })),
      contextGap: false,
      closed: true,
      touchedAt: 0,
    }],
  ])
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  const saved = store.get(key) as { history: Array<{ requestId: string }> }
  expect(saved.history.map(entry => entry.requestId)).toEqual(
    Array.from({ length: 20 }, (_, index) => `request-${index + 5}`),
  )
})

test('startup model failure reports unavailable without fallback', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const statuses: string[] = []
  let modelRequests = 0
  on('session.id', () => ({ value: 'session-startup-failure' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    modelRequests += 1
    return { deny: 'model unavailable' }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(statuses).toEqual([
    'approval reviewer checking',
    'approval reviewer unavailable — model-reviewed asks deny',
  ])
  expect(modelRequests).toBe(1)
})

test('startup treats an unanswered provider result as unavailable', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const statuses: string[] = []
  let modelRequests = 0
  on('session.id', () => ({ value: 'session-startup-unanswered' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    modelRequests += 1
    return {
      value: {
        isAnswered: false,
        reason: 'api-error',
        status: 529,
        error: 'overloaded',
        usage,
      },
    }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(statuses).toEqual([
    'approval reviewer checking',
    'approval reviewer unavailable — model-reviewed asks deny',
  ])
  expect(modelRequests).toBe(1)
})

test('fails closed when the transcript is ahead of retained owner context', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-partial-owner-ledger-20260922'
  const store = new Map<string, unknown>([
    [
      scopedSessionKey('/work', sessionId),
      {
        sessionId,
        workspace: '/work',
        generation: 1,
        instructionGeneration: 1,
        permissionGeneration: 0,
        planMode: false,
        nextOwnerId: 2,
        ownerMessages: [{ id: 'u1', original: 'older instruction', at: 0 }],
        agentTasks: [],
        history: [],
        contextGap: false,
        closed: true,
        touchedAt: 0,
      },
    ],
  ])
  const statuses: string[] = []
  let modelRequests = 0
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'older instruction', toolUses: [] },
      { role: 'user', text: 'new prohibition', toolUses: [] },
    ],
  }))
  on('model.complete', () => {
    modelRequests += 1
    return { value: answeredOk }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(modelRequests).toBe(0)
  expect(statuses).toEqual([
    'approval reviewer checking',
    'approval reviewer unavailable — model-reviewed asks deny',
  ])
  expect(
    (store.get(scopedSessionKey('/work', sessionId)) as { contextGap: boolean }).contextGap,
  ).toBe(true)
})

test('fails closed when retained owner context disagrees with the transcript', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-replaced-owner-ledger-20260922'
  const store = new Map<string, unknown>([
    [
      scopedSessionKey('/work', sessionId),
      {
        sessionId,
        workspace: '/work',
        generation: 1,
        instructionGeneration: 1,
        permissionGeneration: 0,
        planMode: false,
        nextOwnerId: 2,
        ownerMessages: [{ id: 'u1', original: 'old authorization', at: 0 }],
        agentTasks: [],
        history: [],
        contextGap: false,
        closed: true,
        touchedAt: 0,
      },
    ],
  ])
  let modelRequests = 0
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: 'new prohibition', toolUses: [] }],
  }))
  on('model.complete', () => {
    modelRequests += 1
    return { value: answeredOk }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))

  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  expect(modelRequests).toBe(0)
  expect(
    (store.get(scopedSessionKey('/work', sessionId)) as { contextGap: boolean }).contextGap,
  ).toBe(true)
})

test('serializes the shared session index across concurrent sessions', async ($, on) => {
  mock.clock(on)
  const sessionIds = ['session-index-a-20260922', 'session-index-b-20260922']
  const store = new Map<string, unknown>()
  let sessionIdCall = 0
  let indexReads = 0
  let enterIndexRead!: () => void
  let releaseIndexRead!: () => void
  const indexReadEntered = new Promise<void>(resolve => {
    enterIndexRead = resolve
  })
  const indexReadRelease = new Promise<void>(resolve => {
    releaseIndexRead = resolve
  })
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', async (_core, event) => {
    if (event.key === scopedIndexKey('/work')) {
      indexReads += 1
      if (indexReads === 1) {
        enterIndexRead()
        await indexReadRelease
      }
    }
    return { value: store.get(event.key) }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionIds[sessionIdCall++]! }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', (_core, event) => ({ cwd: event.cwd }))

  const first = $.session.start({ cwd: '/work' })
  await indexReadEntered
  const second = $.session.start({ cwd: '/work' })
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  expect(indexReads).toBe(1)
  releaseIndexRead()
  await expect(Promise.all([first, second])).resolves.toEqual([
    { cwd: '/work' },
    { cwd: '/work' },
  ])
  expect(indexReads).toBe(2)
  expect(
    ((store.get(scopedIndexKey('/work')) as Array<{ sessionId: string }>)).map(
      entry => entry.sessionId,
    ).sort(),
  ).toEqual([...sessionIds].sort())
})

test('evicts an old open session without touching another workspace', async ($, on) => {
  mock.clock(on)
  const workspace = '/work/a'
  const neighbor = '/work/b'
  const store = new Map<string, unknown>()
  const old = Array.from({ length: 8 }, (_, index) => ({
    sessionId: `old-${index}`,
    closed: false,
    touchedAt: index + 1,
    bytes: 100,
  }))
  for (const directory of [workspace, neighbor]) {
    store.set(scopedIndexKey(directory), old)
    for (const entry of old) {
      store.set(scopedSessionKey(directory, entry.sessionId), { old: true })
    }
  }
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'new-session' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  const statuses: string[] = []
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', (_core, event) => ({ cwd: event.cwd }))

  await expect($.session.start({ cwd: workspace })).resolves.toEqual({ cwd: workspace })
  expect(statuses.at(-1)).toBe('approval reviewer active')
  expect(store.get(scopedSessionKey(workspace, 'old-0'))).toBeUndefined()
  expect(store.get(scopedSessionKey(neighbor, 'old-0'))).toEqual({ old: true })
  expect(
    (store.get(scopedIndexKey(workspace)) as Array<{ sessionId: string }>).map(
      entry => entry.sessionId,
    ).sort(),
  ).toEqual([...old.slice(1).map(entry => entry.sessionId), 'new-session'].sort())
  expect(store.get(scopedIndexKey(neighbor))).toEqual(old)
  expect(
    (store.get(scopedSessionKey(workspace, 'new-session')) as { workspace: string }).workspace,
  ).toBe(workspace)
})

test('a broken workspace index does not create an orphan or disable other sessions', async ($, on) => {
  mock.clock(on)
  const store = new Map<string, unknown>([[scopedIndexKey('/broken'), 'invalid']])
  let sessionId = 'broken-session'
  const statuses: string[] = []
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', (_core, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/broken' })
  expect(statuses.at(-1)).toBe('approval reviewer active — history store unavailable (store)')
  expect(store.get(scopedSessionKey('/broken', sessionId))).toBeUndefined()

  sessionId = 'healthy-session'
  await $.session.start({ cwd: '/healthy' })
  expect(statuses.at(-1)).toBe('approval reviewer active')
  expect(store.get(scopedSessionKey('/healthy', sessionId))).toBeDefined()
})

test('a store read failure stays in its workspace', async ($, on) => {
  mock.clock(on)
  const retained = { ownerMessages: ['must not be overwritten'] }
  const store = new Map<string, unknown>([
    [scopedSessionKey('/unreadable', 'unreadable-session'), retained],
  ])
  let sessionId = 'unreadable-session'
  const statuses: string[] = []
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => {
    if (event.key === scopedSessionKey('/unreadable', 'unreadable-session')) {
      throw new Error('store unavailable')
    }
    return { value: store.get(event.key) }
  })
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', (_core, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/unreadable' })
  expect(statuses.at(-1)).toBe('approval reviewer unavailable — model-reviewed asks deny (store)')
  expect(store.get(scopedSessionKey('/unreadable', sessionId))).toBe(retained)

  sessionId = 'healthy-after-read-failure'
  await $.session.start({ cwd: '/healthy' })
  expect(statuses.at(-1)).toBe('approval reviewer active')
})

test('does not import unscoped history into a workspace', async ($, on) => {
  mock.clock(on)
  const sessionId = 'legacy-session'
  const unscoped = {
    sessionId,
    workspace: '/new-workspace',
    generation: 1,
    instructionGeneration: 1,
    permissionGeneration: 0,
    planMode: false,
    nextOwnerId: 2,
    ownerMessages: [{ id: 'u1', original: 'old instruction', at: 0 }],
    agentTasks: [],
    history: [],
    contextGap: false,
    closed: true,
    touchedAt: 0,
  }
  const store = new Map<string, unknown>([[`session:${sessionId}`, unscoped]])
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/new-workspace' }))

  await $.session.start({ cwd: '/new-workspace' })
  expect((store.get(scopedSessionKey('/new-workspace', sessionId)) as { ownerMessages: unknown[] }).ownerMessages).toEqual([])
  expect(store.get(`session:${sessionId}`)).toBe(unscoped)
})

test('restores each workspace from its own persisted session', async ($, on) => {
  mock.clock(on)
  const store = new Map<string, unknown>()
  const sessions = [
    { id: 'workspace-a-session', workspace: '/work/a', instruction: 'instruction A' },
    { id: 'workspace-b-session', workspace: '/work/b', instruction: 'instruction B' },
  ]
  for (const session of sessions) {
    store.set(scopedSessionKey(session.workspace, session.id), {
      sessionId: session.id,
      workspace: session.workspace,
      generation: 1,
      instructionGeneration: 1,
      permissionGeneration: 0,
      planMode: false,
      nextOwnerId: 2,
      ownerMessages: [{ id: 'u1', original: session.instruction, at: 0 }],
      agentTasks: [],
      history: [],
      contextGap: false,
      closed: true,
      touchedAt: 0,
    })
  }
  let active = sessions[0]!
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('session.id', () => ({ value: active.id }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: active.instruction, toolUses: [] }],
  }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', (_core, event) => ({ cwd: event.cwd }))

  for (const session of sessions) {
    active = session
    await $.session.start({ cwd: session.workspace })
    expect(
      (store.get(scopedSessionKey(session.workspace, session.id)) as {
        ownerMessages: Array<{ original: string }>
      }).ownerMessages.map(message => message.original),
    ).toEqual([session.instruction])
  }
})

test('reactivates a closed session on same-runtime resume', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-resume-same-runtime-20260920'
  const store = new Map<string, unknown>()
  let downstreamCalls = 0
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))
  on('prompt.submit', (_core, event) => ({ text: event.text }))
  on('tool.call', () => {
    downstreamCalls += 1
    return { result: undefined }
  })

  await $.session.start({ cwd: '/work' })
  await $.prompt.submit({
    text: 'keep this constraint',
    origin: { kind: 'composer' },
  } as never)
  await $.session.end({ sessionId })
  await $.session.start({ cwd: '/work' })
  await expect(
    $.tool.call({ tool: 'Example', tool_use_id: 'resume-call-1', input: {} }),
  ).resolves.toEqual({ result: undefined })
  expect(downstreamCalls).toBe(1)
  expect(
    (store.get(scopedSessionKey('/work', sessionId)) as {
      ownerMessages: Array<{ original: string }>
    }).ownerMessages.map(message => message.original),
  ).toEqual(['keep this constraint'])
})

test('handles a new conversation after clear without a native session.start', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let sessionId = 'before-clear'
  let downstreamCalls = 0
  const statuses: string[] = []
  let enterOldRoot!: () => void
  let releaseOldRoot!: () => void
  const oldRootEntered = new Promise<void>(resolve => {
    enterOldRoot = resolve
  })
  const oldRootRelease = new Promise<void>(resolve => {
    releaseOldRoot = resolve
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/work/sub' }))
  on('session.root', async () => {
    if (sessionId === 'before-clear') {
      enterOldRoot()
      await oldRootRelease
    }
    return { value: '/work' }
  })
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', (_core, event) => ({ cwd: event.cwd }))
  on('session.end', () => ({ sessionId }))
  on('prompt.submit', (_core, event) => ({ text: event.text }))
  on('tool.call', () => {
    downstreamCalls += 1
    return { result: undefined }
  })

  await $.session.start({ cwd: '/work/sub' })
  const oldCall = $.tool.call({ tool: 'Example', tool_use_id: 'before-clear-call', input: {} })
  await oldRootEntered
  await $.session.end({ sessionId })
  sessionId = 'after-clear'
  await $.prompt.submit({
    text: 'run the harmless command',
    origin: { kind: 'composer' },
  } as never)
  await expect(
    $.tool.call({ tool: 'Example', tool_use_id: 'after-clear-call', input: {} }),
  ).resolves.toEqual({ result: undefined })
  releaseOldRoot()
  await expect(oldCall).resolves.toEqual({ deny: 'Approval reviewer session is closed.' })
  expect(downstreamCalls).toBe(1)

  await $.session.end({ sessionId })
  await $.session.start({ cwd: '/work/sub' })
  expect(statuses.at(-1)).toBe('approval reviewer active')

  await $.session.end({ sessionId })
  sessionId = 'after-clear-bridge'
  await $.prompt.submit({
    text: 'run the harmless command',
    origin: { kind: 'bridge' },
  } as never)
  await expect(
    $.tool.call({ tool: 'Example', tool_use_id: 'bridge-call', input: {} }),
  ).resolves.toEqual({ result: undefined })
  expect(downstreamCalls).toBe(2)
})

test('denies a tool call prepared across same-runtime resume', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const sessionId = 'session-resume-race-20260920'
  let downstreamCalls = 0
  let enterRoot!: () => void
  let releaseRoot!: () => void
  const rootEntered = new Promise<void>(resolve => {
    enterRoot = resolve
  })
  const rootRelease = new Promise<void>(resolve => {
    releaseRoot = resolve
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', async () => {
    enterRoot()
    await rootRelease
    return { value: '/work' }
  })
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))
  on('tool.call', () => {
    downstreamCalls += 1
    return { result: undefined }
  })

  await $.session.start({ cwd: '/work' })
  const pendingCall = $.tool.call({
    tool: 'Example',
    tool_use_id: 'resume-race-call-1',
    input: {},
  })
  await rootEntered
  await $.session.end({ sessionId })
  await $.session.start({ cwd: '/work' })
  releaseRoot()

  await expect(pendingCall).resolves.toEqual({
    deny: 'Approval reviewer session is closed.',
  })
  expect(downstreamCalls).toBe(0)
})

test('preserves a downstream allow decision', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  await expect(
    $.tool.check({ tool: 'Example', input: {} }),
  ).resolves.toEqual({ decision: 'allow' })
})

test('preserves a downstream deny decision', async ($, on) => {
  on('tool.check', () => ({ decision: 'deny' }))
  await expect(
    $.tool.check({ tool: 'Example', input: {} }),
  ).resolves.toEqual({ decision: 'deny' })
})

test('denies ExitPlanMode asks directly', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'session-plan' }))
  on('tool.check', () => ({ decision: 'ask', reason: 'Exit plan mode?' }))

  await expect(
    $.tool.check({ tool: 'ExitPlanMode', input: { plan: 'Implement it.' } }),
  ).resolves.toEqual({
    decision: 'deny',
    reason: 'Approval reviewer does not approve leaving Plan mode.',
  })
})

test('an uncorrelated pending ask fails closed', async ($, on) => {
  on('session.id', () => {
    throw new Error('injected session failure')
  })
  on('tool.check', () => ({ decision: 'ask' }))

  await expect(
    $.tool.check({ tool: 'Example', input: {} }),
  ).resolves.toEqual({
    decision: 'deny',
    reason:
      'Approval reviewer unavailable (context-integrity); this request was denied.',
  })
})

test('does not commit an owner prompt after the session is resumed', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-prompt-resume-race-20260920'
  const store = new Map<string, unknown>()
  const sets: Array<{ key: string; value: unknown }> = []
  let enterPrompt!: () => void
  let releasePrompt!: () => void
  const promptEntered = new Promise<void>(resolve => {
    enterPrompt = resolve
  })
  const promptRelease = new Promise<void>(resolve => {
    releasePrompt = resolve
  })
  on('store.set', (_core, event) => {
    sets.push({ key: event.key, value: event.value })
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))
  on('prompt.submit', async (_core, event) => {
    if (event.text === 'old prompt') {
      enterPrompt()
      await promptRelease
    }
    return { text: event.text }
  })

  await $.session.start({ cwd: '/work' })
  const pending = $.prompt.submit({
    text: 'old prompt',
    origin: { kind: 'composer' },
  } as never)
  await promptEntered
  await $.session.end({ sessionId })
  await $.session.start({ cwd: '/work' })
  releasePrompt()

  await expect(pending).resolves.toEqual({ text: 'old prompt' })
  const sessionWrites = sets.filter(entry => entry.key === scopedSessionKey('/work', sessionId))
  expect(sessionWrites.length).toBe(3)
  for (const entry of sessionWrites) {
    expect((entry.value as { ownerMessages: unknown[] }).ownerMessages).toEqual([])
  }
  expect(
    (sessionWrites.at(-1)?.value as { generation: number }).generation,
  ).toBe(3)
})

test('does not retain a subagent prompt after the session is resumed', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-agent-resume-race-20260922'
  const store = new Map<string, unknown>()
  let enterSpawn!: () => void
  let releaseSpawn!: () => void
  const spawnEntered = new Promise<void>(resolve => {
    enterSpawn = resolve
  })
  const spawnRelease = new Promise<void>(resolve => {
    releaseSpawn = resolve
  })
  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: answeredOk }))
  on('command.register', () => ({ value: {} }))
  on('ui.status', () => ({ value: null }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))
  on('agent.spawn', async () => {
    enterSpawn()
    await spawnRelease
    return { model: 'sonnet', agentId: 'stale-agent' }
  })

  await $.session.start({ cwd: '/work' })
  const pending = $.agent.spawn({ prompt: 'old delegated task' })
  await spawnEntered
  await $.session.end({ sessionId })
  await $.session.start({ cwd: '/work' })
  releaseSpawn()

  await expect(pending).resolves.toEqual({
    model: 'sonnet',
    agentId: 'stale-agent',
  })
  expect(
    (store.get(scopedSessionKey('/work', sessionId)) as { agentTasks: unknown[] }).agentTasks,
  ).toEqual([])
})

test('tombstones a pending state load when the session ends', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-end-during-load-20260921'
  const store = new Map<string, unknown>()
  const statuses: string[] = []
  let enterStoreGet!: () => void
  let releaseStoreGet!: () => void
  const storeGetEntered = new Promise<void>(resolve => {
    enterStoreGet = resolve
  })
  const storeGetRelease = new Promise<void>(resolve => {
    releaseStoreGet = resolve
  })
  let holdSessionGet = true
  let modelRequests = 0

  on('store.set', (_core, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', async (_core, event) => {
    if (holdSessionGet && event.key === scopedSessionKey('/work', sessionId)) {
      holdSessionGet = false
      enterStoreGet()
      await storeGetRelease
    }
    return { value: store.get(event.key) }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    modelRequests += 1
    return { value: answeredOk }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))

  const pendingStart = $.session.start({ cwd: '/work' })
  await storeGetEntered
  await expect($.session.end({ sessionId })).resolves.toEqual({ sessionId })
  releaseStoreGet()

  await expect(pendingStart).resolves.toEqual({ cwd: '/work' })
  await expect(
    $.tool.call({ tool: 'Example', tool_use_id: 'ended-load-call', input: {} }),
  ).resolves.toEqual({ deny: 'Approval reviewer session is closed.' })
  expect(statuses).toEqual([])
  expect(modelRequests).toBe(0)
  expect(store.get(scopedSessionKey('/work', sessionId))).toBeUndefined()
})

test('does not let stale startup overwrite a resumed generation', async ($, on) => {
  mock.clock(on)
  const sessionId = 'session-stale-startup-20260921'
  const store = new Map<string, unknown>([
    [
      scopedSessionKey('/work', sessionId),
      {
        sessionId,
        workspace: '/work',
        generation: 1,
        instructionGeneration: 0,
        permissionGeneration: 0,
        planMode: false,
        nextOwnerId: 2,
        ownerMessages: [{ id: 'u1', original: 'retain this', at: 0 }],
        agentTasks: [],
        history: [
          {
            requestId: 'history-1',
            fingerprint: 'fingerprint-1',
            action: 'Example request',
            verdict: 'allow',
            reason: 'already retained',
            elapsedMs: 0,
            at: 0,
          },
        ],
        contextGap: false,
        closed: false,
        touchedAt: 0,
      },
    ],
  ])
  const sets: Array<{ key: string; value: unknown }> = []
  const statuses: string[] = []
  let enterOldMessages!: () => void
  let releaseOldMessages!: () => void
  const oldMessagesEntered = new Promise<void>(resolve => {
    enterOldMessages = resolve
  })
  const oldMessagesRelease = new Promise<void>(resolve => {
    releaseOldMessages = resolve
  })
  let messageCalls = 0
  let modelRequests = 0

  on('store.set', (_core, event) => {
    sets.push({ key: event.key, value: event.value })
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.get', (_core, event) => ({ value: store.get(event.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_core, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', async () => {
    messageCalls += 1
    if (messageCalls === 1) {
      enterOldMessages()
      await oldMessagesRelease
    }
    return { value: [] }
  })
  on('model.complete', () => {
    modelRequests += 1
    return { value: answeredOk }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.status', (_core, event) => {
    statuses.push(event.text)
    return { value: null }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', () => ({ sessionId }))

  const oldStart = $.session.start({ cwd: '/work' })
  await oldMessagesEntered
  await $.session.end({ sessionId })
  await expect($.session.start({ cwd: '/work' })).resolves.toEqual({ cwd: '/work' })
  releaseOldMessages()
  await expect(oldStart).resolves.toEqual({ cwd: '/work' })

  const sessionWrites = sets.filter(entry => entry.key === scopedSessionKey('/work', sessionId))
  expect(statuses).toEqual([
    'approval reviewer checking',
    'approval reviewer active',
  ])
  expect(modelRequests).toBe(1)
  expect(sessionWrites.map(entry => (entry.value as { generation: number }).generation)).toEqual([
    3,
    4,
  ])
  expect(sessionWrites.map(entry => (entry.value as { closed: boolean }).closed)).toEqual([
    true,
    false,
  ])
  expect(
    (store.get(scopedSessionKey('/work', sessionId)) as {
      generation: number
      closed: boolean
      ownerMessages: Array<{ original: string }>
      history: Array<{ requestId: string }>
    }),
  ).toEqual(
    expect.objectContaining({
      generation: 4,
      closed: false,
      ownerMessages: [{ id: 'u1', original: 'retain this', at: 0 }],
      history: [
        expect.objectContaining({ requestId: 'history-1' }),
      ],
    }),
  )
})
