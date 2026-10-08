import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findProjectRoot (startDir: string): string {
  let dir = startDir
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

export const DEV_DATA_DIR = '.dev-data'
export const SERVICE_CONFIG_FILE = 'services.json'

export interface PortableContext {
  isPackaged?: boolean
  execPath?: string
  portableExecutableDir?: string
  projectRoot?: string
  envPortableAppRoot?: string
}

export interface PortablePaths {
  appRoot: string
  data: string
  logs: string
  profiles: string
  temp: string
  cache: string
  sessionData: string
  configFile: string
}

/**
 * Determine the portable application root.
 *
 * For a packaged app we want the directory that contains the launcher so the
 * data/ folder lives next to the program. electron-builder portable sets
 * PORTABLE_EXECUTABLE_DIR to that directory. If it is missing we fall back to
 * the executable's directory.
 *
 * In development we keep data out of the source tree root by using .dev-data,
 * but the returned appRoot is still the repository root.
 *
 * Relative overrides are rejected because they would be CWD-dependent and
 * could place data in an unintended location.
 */
function isAbsolutePath (value: string): boolean {
  if (value.length === 0) return false
  return path.isAbsolute(value)
}

export class PortablePathError extends Error {
  readonly code: string
  constructor (message: string, code: string) {
    super(message)
    this.code = code
    this.name = 'PortablePathError'
  }
}

/**
 * Validate an explicitly provided portable root/launcher path. Relative paths
 * are rejected because they would be CWD-dependent and could place data in an
 * unintended location. Fail-closed: any invalid explicit override throws.
 */
export function validatePortableContext (context: PortableContext): void {
  const portableDir = context.portableExecutableDir?.trim()
  if (portableDir != null && portableDir.length > 0 && !isAbsolutePath(portableDir)) {
    throw new PortablePathError(
      `PORTABLE_EXECUTABLE_DIR must be an absolute path, got: ${portableDir}`,
      'EINVAL',
    )
  }

  const execPath = context.execPath?.trim()
  if (execPath != null && execPath.length > 0 && !isAbsolutePath(execPath)) {
    throw new PortablePathError(
      `execPath must be an absolute path, got: ${execPath}`,
      'EINVAL',
    )
  }

  const envRoot = context.envPortableAppRoot?.trim()
  if (envRoot != null && envRoot.length > 0 && !isAbsolutePath(envRoot)) {
    throw new PortablePathError(
      `PORTABLE_APP_ROOT must be an absolute path, got: ${envRoot}`,
      'EINVAL',
    )
  }
}

export function getAppRoot (context: PortableContext = {}): string {
  validatePortableContext(context)
  const projectRoot = context.projectRoot ?? findProjectRoot(path.resolve(__dirname, '..'))

  if (context.isPackaged) {
    const portableDir = context.portableExecutableDir?.trim()
    if (portableDir != null && portableDir.length > 0) {
      return path.normalize(portableDir)
    }

    const execPath = context.execPath?.trim()
    if (execPath != null && execPath.length > 0) {
      const exeDir = path.dirname(path.normalize(execPath))
      if (exeDir.length > 0) {
        return exeDir
      }
    }
  }

  if (context.envPortableAppRoot != null) {
    const envRoot = context.envPortableAppRoot.trim()
    if (envRoot.length > 0) return path.normalize(envRoot)
  }

  return projectRoot
}

export function getPortablePaths (context: PortableContext = {}): PortablePaths {
  const appRoot = getAppRoot(context)
  const dataName = context.isPackaged === true ? 'data' : DEV_DATA_DIR
  const data = path.join(appRoot, dataName)
  return {
    appRoot,
    data,
    logs: path.join(data, 'logs'),
    profiles: path.join(data, 'profiles'),
    temp: path.join(data, 'tmp'),
    cache: path.join(data, 'cache'),
    sessionData: path.join(data, 'session-data'),
    configFile: path.join(data, SERVICE_CONFIG_FILE),
  }
}

export function profilePath (serviceId: string, paths?: PortablePaths): string {
  if (!/^[a-z0-9_-]+$/i.test(serviceId)) {
    throw new Error(`Invalid service id: ${serviceId}`)
  }
  const base = paths ?? getPortablePaths()
  return path.join(base.profiles, serviceId)
}

export function sessionPartitionForService (serviceId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(serviceId)) {
    throw new Error(`Invalid service id: ${serviceId}`)
  }
  return `persist:fm-sprachbox-${serviceId}`
}

function isReadonlyError (code?: string): boolean {
  return code === 'EACCES' || code === 'EROFS' || code === 'EPERM'
}

function isNoSpaceError (code?: string): boolean {
  return code === 'ENOSPC'
}

function writeProbe (dir: string): void {
  const probeName = `.fm-sprachbox-write-probe-${process.pid}-${Date.now()}`
  const probePath = path.join(dir, probeName)
  try {
    fs.writeFileSync(probePath, Buffer.from('probe'))
    fs.rmSync(probePath, { force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (isReadonlyError(code)) {
      throw new PortablePathError(
        `Cannot write portable data directory (${code ?? 'EACCES'}). The location is read-only: ${dir}`,
        code ?? 'EACCES',
      )
    }
    if (isNoSpaceError(code)) {
      throw new PortablePathError(
        `Cannot write portable data directory (${code ?? 'ENOSPC'}). Disk is full: ${dir}`,
        code ?? 'ENOSPC',
      )
    }
    throw err
  }
}

/**
 * Create the portable data directories, then prove we can actually write to
 * them. Recursive mkdir succeeds even when a parent is read-only as long as
 * the final segment already exists, so a real write/delete probe is required.
 * Throws on read-only or full disks so the app does not silently fall back
 * to AppData.
 */
export function preparePortablePaths (paths: PortablePaths): void {
  const dirs = [paths.data, paths.logs, paths.profiles, paths.temp, paths.cache, paths.sessionData]
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (isReadonlyError(code)) {
        throw new PortablePathError(
          `Cannot create portable data directory (${code ?? 'EACCES'}). The location is read-only: ${dir}`,
          code ?? 'EACCES',
        )
      }
      if (isNoSpaceError(code)) {
        throw new PortablePathError(
          `Cannot create portable data directory (${code ?? 'ENOSPC'}). Disk is full: ${dir}`,
          code ?? 'ENOSPC',
        )
      }
      throw err
    }
    writeProbe(dir)
  }
}
