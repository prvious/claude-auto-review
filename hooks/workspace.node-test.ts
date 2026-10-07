import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyWorkspaceMutation,
  type WorkspaceHost,
} from './workspace.ts'

type FakeFs = {
  files?: string[]
  dirs?: string[]
  links?: string[]
  entries?: Record<string, unknown[]>
}

const fakeHost = (source: FakeFs): WorkspaceHost => {
  const files = new Set(source.files ?? [])
  const dirs = new Set(['/work', '/work/app', ...(source.dirs ?? [])])
  const links = new Set(source.links ?? [])
  return {
    async stat(path) {
      if (links.has(path)) {
        return { kind: 'file', realPath: path, isLink: true }
      }
      if (dirs.has(path)) return { kind: 'dir', realPath: path, isLink: false }
      if (files.has(path)) return { kind: 'file', realPath: path, isLink: false }
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    async list(path) {
      return source.entries?.[path] ?? []
    },
  }
}

const mutation = (tool: string, input: Record<string, unknown>, extra = {}) => ({
  tool,
  input,
  cwd: '/work/app',
  root: '/work',
  ...extra,
})

test('allows existing Edit, Write, and NotebookEdit files in the workspace', async () => {
  const host = fakeHost({
    files: ['/work/app/routes.php', '/work/app/notebook.ipynb'],
  })
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/routes.php' }),
    ),
    '/work/app/routes.php',
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/routes.php' }),
    ),
    '/work/app/routes.php',
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('NotebookEdit', { notebook_path: '/work/app/notebook.ipynb' }),
    ),
    '/work/app/notebook.ipynb',
  )
})

test('allows a new Write only after proving the parent and basename are free', async () => {
  const host = fakeHost({
    entries: {
      '/work/app': [
        'other.php',
        { path: '/work/app/another.php' },
        { name: 'routes.php' },
      ],
    },
  })
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/new.php' }),
    ),
    '/work/app/new.php',
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/routes.php' }),
    ),
    undefined,
  )
})

test('requires ENOENT and a well-formed parent listing for a new Write', async () => {
  const target = '/work/app/new.ts'
  const inaccessible: WorkspaceHost = {
    async stat(path) {
      if (path === target) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return { kind: 'dir', realPath: path, isLink: false }
    },
    async list() {
      return []
    },
  }
  assert.equal(
    await classifyWorkspaceMutation(
      inaccessible,
      mutation('Write', { file_path: target }),
    ),
    undefined,
  )

  for (const entry of [
    '/work/app/',
    '/work/app/../other.ts',
    '/outside/other.ts',
    { path: '/outside/other.ts' },
    { name: 'other.ts', path: '/outside/other.ts' },
    { name: 'other.ts', path: '/work/app/different.ts' },
    { name: 7, path: '/work/app/other.ts' },
    '',
    '.',
    '..',
  ]) {
    const malformed = fakeHost({ entries: { '/work/app': [entry] } })
    assert.equal(
      await classifyWorkspaceMutation(
        malformed,
        mutation('Write', { file_path: target }),
      ),
      undefined,
    )
  }
})

test('falls through on outside, protected, symlink, and ambiguous paths', async () => {
  const host = fakeHost({
    files: [
      '/work/app-evil/file.ts',
      '/work/app/.git/config',
      '/work/app/.claude/settings.json',
      '/work/app/package/.git/config',
    ],
    links: ['/work/app/link.ts', '/work/app/link-parent'],
    entries: { '/work/app': [{ malformed: true }] },
  })
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app-evil/file.ts' }, { root: '/work/app' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/.git/config' }, { root: '/work/app' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/.claude/settings.json' }, { root: '/work/app' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/package/.git/config' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/link.ts' }, { root: '/work/app' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/new.ts' }, { root: '/work/app' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/link-parent/new.ts' }),
    ),
    undefined,
  )
})

test('does not treat malformed target metadata as a new Write', async () => {
  const host: WorkspaceHost = {
    async stat(path) {
      if (path === '/work' || path === '/work/app') {
        return { kind: 'dir', realPath: path, isLink: false }
      }
      return null
    },
    async list() {
      return []
    },
  }

  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: '/work/app/new.ts' }),
    ),
    undefined,
  )
})

test('uses canonical paths and the full root rather than only cwd', async () => {
  const host: WorkspaceHost = {
    async stat(path) {
      if (path === '/alias') return { kind: 'dir', realPath: '/real/work', isLink: false }
      if (path === '/alias/app') {
        return { kind: 'dir', realPath: '/real/work/app', isLink: false }
      }
      if (path === '/alias/sibling.ts') {
        return { kind: 'file', realPath: '/real/work/sibling.ts', isLink: false }
      }
      if (path === '/alias/escape.ts') {
        return { kind: 'file', realPath: '/outside/escape.ts', isLink: false }
      }
      throw new Error(`missing: ${path}`)
    },
    async list() {
      return []
    },
  }

  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation(
        'Edit',
        { file_path: '/alias/sibling.ts' },
        { root: '/alias', cwd: '/alias/app' },
      ),
    ),
    '/real/work/sibling.ts',
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation(
        'Edit',
        { file_path: '/alias/escape.ts' },
        { root: '/alias', cwd: '/alias/app' },
      ),
    ),
    undefined,
  )
})

test('requires a non-root workspace and cwd inside it', async () => {
  const host = fakeHost({ files: ['/work/app/file.ts'] })
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/file.ts' }, { root: '/' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/file.ts' }, { cwd: '/outside' }),
    ),
    undefined,
  )
})

test('ignores unrelated tools and unsafe path spellings', async () => {
  const host = fakeHost({ files: ['/work/app/file.ts'] })
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Bash', { file_path: '/work/app/file.ts' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: 'file.ts' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/../file.ts' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('NotebookEdit', { notebook_path: '/work/app/file.ts' }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Write', { file_path: `/${'x'.repeat(4_096)}` }),
    ),
    undefined,
  )
  assert.equal(
    await classifyWorkspaceMutation(
      host,
      mutation('Edit', { file_path: '/work/app/missing.ts' }),
    ),
    undefined,
  )
})

test('case aliases of protected directories never receive workspace fast approval', async () => {
  for (const segment of ['.Git', '.GIT', '.Claude', '.cLaUdE']) {
    const path = `/work/app/${segment}/config`
    const host = fakeHost({ files: [path], dirs: [`/work/app/${segment}`] })
    assert.equal(await classifyWorkspaceMutation(host, mutation('Edit', { file_path: path })), undefined)
    assert.equal(await classifyWorkspaceMutation(host, mutation('Write', { file_path: `/work/app/${segment}/new.json` })), undefined)
  }
})

test('new protected files are reviewed under every case spelling', async () => {
  for (const segment of ['.Git', '.GIT', '.Claude', '.cLaUdE']) {
    assert.equal(await classifyWorkspaceMutation(fakeHost({}), mutation('Write', { file_path: `/work/app/${segment}` })), undefined)
  }
})
