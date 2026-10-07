export type WorkspaceHost = {
  stat: (path: string, options: { resolve: true }) => Promise<unknown>
  list: (path: string) => Promise<readonly unknown[]>
}

export type WorkspaceMutation = {
  tool: string
  input: unknown
  cwd: string
  root: string
}

const pathName = (path: string) => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

const normalized = (path: string) => {
  if (path.length > 1) return path.replace(/\/+$/, '')
  return path
}

const absolutePath = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('//')
  ) {
    return undefined
  }
  if (value.split('/').some(part => part === '.' || part === '..')) return undefined
  return normalized(value)
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`)

const protectedPath = (root: string, path: string) =>
  inside(root, path) &&
  path.split('/').some(part => ['.git', '.claude'].includes(part.toLowerCase()))

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const notFound = (error: unknown) => {
  const value = record(error)
  if (value?.code === 'ENOENT') return true
  const message =
    error instanceof Error
      ? error.message
      : typeof value?.message === 'string'
        ? value.message
        : ''
  return /\bENOENT\b/.test(message)
}

const resolvedDirectory = async (host: WorkspaceHost, path: string) => {
  const stat = record(await host.stat(path, { resolve: true }))
  if (!stat) return undefined
  const realPath = absolutePath(stat.realPath)
  if (stat.kind !== 'dir' || !realPath || stat.isLink !== false) {
    return undefined
  }
  return realPath
}

const entryName = (value: unknown, parent: string) => {
  const valid = (name: string) =>
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
      ? name
      : undefined
  const fromPath = (value: string) => {
    if (value.endsWith('/')) return undefined
    const path = absolutePath(value)
    if (!path) return undefined
    const slash = path.lastIndexOf('/')
    const directory = slash <= 0 ? '/' : path.slice(0, slash)
    return directory === parent ? valid(pathName(path)) : undefined
  }
  if (typeof value === 'string') {
    if (!value.includes('/')) return valid(value)
    return fromPath(value)
  }
  const item = record(value)
  if (!item) return undefined
  const hasName = Object.prototype.hasOwnProperty.call(item, 'name')
  const hasPath = Object.prototype.hasOwnProperty.call(item, 'path')
  const byName = typeof item.name === 'string' ? valid(item.name) : undefined
  const byPath = typeof item.path === 'string' ? fromPath(item.path) : undefined
  if ((hasName && byName === undefined) || (hasPath && byPath === undefined)) {
    return undefined
  }
  if (byName && byPath && byName !== byPath) return undefined
  return byName ?? byPath
}

async function newWriteTarget(
  host: WorkspaceHost,
  root: string,
  path: string,
) {
  const slash = path.lastIndexOf('/')
  const parent = slash <= 0 ? '/' : path.slice(0, slash)
  const name = path.slice(slash + 1)
  if (!name || name === '.' || name === '..') return undefined

  try {
    const parentRealPath = await resolvedDirectory(host, parent)
    if (
      !parentRealPath ||
      !inside(root, parentRealPath) ||
      protectedPath(root, parentRealPath)
    ) {
      return undefined
    }
    const entries = await host.list(parentRealPath)
    if (!Array.isArray(entries)) return undefined
    for (const entry of entries) {
      const existingName = entryName(entry, parentRealPath)
      if (existingName === undefined) return undefined
      if (existingName === name) return undefined
    }
    const prospective = `${parentRealPath}/${name}`
    if (!inside(root, prospective) || protectedPath(root, prospective)) return undefined
    return prospective
  } catch {
    return undefined
  }
}

export async function classifyWorkspaceMutation(
  host: WorkspaceHost,
  mutation: WorkspaceMutation,
): Promise<string | undefined> {
  if (!['Edit', 'Write', 'NotebookEdit'].includes(mutation.tool)) return undefined

  const rootPath = absolutePath(mutation.root)
  const cwdPath = absolutePath(mutation.cwd)
  if (!rootPath || !cwdPath || rootPath === '/') return undefined

  const input = record(mutation.input)
  const field = mutation.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const targetPath = absolutePath(input?.[field])
  if (!targetPath) return undefined
  if (mutation.tool === 'NotebookEdit' && !targetPath.endsWith('.ipynb')) return undefined

  try {
    const root = await resolvedDirectory(host, rootPath)
    const cwd = await resolvedDirectory(host, cwdPath)
    if (!root || !cwd || root === '/' || !inside(root, cwd) || protectedPath(root, cwd)) {
      return undefined
    }

    try {
      const stat = record(await host.stat(targetPath, { resolve: true }))
      if (!stat) return undefined
      if (
        stat.kind === 'file' &&
        stat.isLink === false
      ) {
        const target = absolutePath(stat.realPath)
        if (!target) return undefined
        return inside(root, target) && !protectedPath(root, target) ? target : undefined
      }
      return undefined
    } catch (error) {
      // A Write may be new; parent resolution and listing must prove a free target.
      if (mutation.tool !== 'Write' || !notFound(error)) return undefined
    }

    return await newWriteTarget(host, root, targetPath)
  } catch {
    return undefined
  }
}
