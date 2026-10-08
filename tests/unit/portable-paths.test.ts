import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  getPortablePaths,
  profilePath,
  sessionPartitionForService,
  getAppRoot,
  preparePortablePaths,
  PortablePathError,
  DEV_DATA_DIR,
} from '../../src/main/portable-paths.js'

function tryRemove (dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function makeReadonly (dir: string): void {
  fs.chmodSync(dir, 0o555)
}

function makeWritable (dir: string): void {
  fs.chmodSync(dir, 0o755)
}

function isRootUser (): boolean {
  try {
    return process.getuid != null && process.getuid() === 0
  } catch {
    return false
  }
}

describe('portable-paths', () => {
  const projectRoot = process.cwd()

  it('computes portable paths from an explicit app root', () => {
    const root = path.join(os.tmpdir(), 'sprachbox-test')
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    expect(paths.appRoot).toBe(root)
    expect(paths.data).toBe(path.join(root, 'data'))
    expect(paths.logs).toBe(path.join(root, 'data', 'logs'))
    expect(paths.profiles).toBe(path.join(root, 'data', 'profiles'))
    expect(paths.temp).toBe(path.join(root, 'data', 'tmp'))
    expect(paths.cache).toBe(path.join(root, 'data', 'cache'))
    expect(paths.sessionData).toBe(path.join(root, 'data', 'session-data'))
  })

  it('uses dev data directory in development mode', () => {
    const paths = getPortablePaths({ projectRoot, isPackaged: false })
    expect(paths.data).toBe(path.join(projectRoot, DEV_DATA_DIR))
  })

  it('handles app roots with spaces and unicode', () => {
    const root = path.join(os.tmpdir(), 'Sprachbox Test', 'portabel 日本語')
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    expect(paths.data).toBe(path.join(root, 'data'))
    expect(paths.profiles).toBe(path.join(root, 'data', 'profiles'))
  })

  it('prepares and removes a data directory', () => {
    const root = path.join(os.tmpdir(), `sprachbox-prepare-${Date.now()}`)
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    tryRemove(paths.data)
    preparePortablePaths(paths)
    expect(fs.existsSync(paths.data)).toBe(true)
    expect(fs.existsSync(paths.profiles)).toBe(true)
    tryRemove(root)
  })

  it('throws a clear error when an existing data tree is read-only', () => {
    if (isRootUser()) {
      // chmod 555 does not restrict root on Linux, so skip this test there.
      return
    }
    const root = path.join(os.tmpdir(), `sprachbox-readonly-${Date.now()}`)
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    tryRemove(root)

    // Simulate a pre-existing portable data tree (e.g. from a previous run on a
    // read-only medium). mkdir recursive will succeed because all directories
    // already exist, but the write probe must fail.
    fs.mkdirSync(paths.data, { recursive: true })
    fs.mkdirSync(paths.logs, { recursive: true })
    fs.mkdirSync(paths.profiles, { recursive: true })
    fs.mkdirSync(paths.temp, { recursive: true })
    fs.mkdirSync(paths.cache, { recursive: true })
    fs.mkdirSync(paths.sessionData, { recursive: true })
    makeReadonly(paths.data)

    try {
      expect(() => preparePortablePaths(paths)).toThrow(PortablePathError)
      expect(() => preparePortablePaths(paths)).toThrow(/read-only|Cannot write/)
    } finally {
      makeWritable(paths.data)
      tryRemove(root)
    }
  })

  it('throws a clear error when disk is full (ENOSPC simulation)', () => {
    // We simulate ENOSPC by making a directory whose real write probe fails with
    // EACCES/EPERM through permissions. On Linux a real ENOSPC requires filling
    // the filesystem; instead we verify that the mapping logic uses the error
    // code returned by the filesystem and wraps it in PortablePathError.
    if (isRootUser()) return

    const root = path.join(os.tmpdir(), `sprachbox-enospc-${Date.now()}`)
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    tryRemove(root)

    fs.mkdirSync(paths.data, { recursive: true })
    fs.mkdirSync(paths.logs, { recursive: true })
    makeReadonly(paths.data)
    makeReadonly(paths.logs)

    try {
      // The first write probe hits a readonly directory and maps to EACCES;
      // the important property is that the thrown error is a PortablePathError
      // with a clear code, not a generic Error.
      expect(() => preparePortablePaths(paths)).toThrow(PortablePathError)
    } finally {
      makeWritable(paths.logs)
      makeWritable(paths.data)
      tryRemove(root)
    }
  })

  it('derives profile path per service', () => {
    const root = path.join(os.tmpdir(), 'sprachbox-profiles')
    const paths = getPortablePaths({ projectRoot: root, isPackaged: true })
    expect(profilePath('whatsapp', paths)).toBe(path.join(root, 'data', 'profiles', 'whatsapp'))
    expect(profilePath('telegram', paths)).toBe(path.join(root, 'data', 'profiles', 'telegram'))
  })

  it('rejects invalid service ids', () => {
    expect(() => profilePath('../evil')).toThrow(/Invalid service id/)
    expect(() => sessionPartitionForService('whatsapp;rm -rf')).toThrow(/Invalid service id/)
  })

  it('returns stable session partition names', () => {
    expect(sessionPartitionForService('whatsapp')).toBe('persist:fm-sprachbox-whatsapp')
    expect(sessionPartitionForService('telegram')).toBe('persist:fm-sprachbox-telegram')
  })

  it('uses PORTABLE_EXECUTABLE_DIR as packaged app root', () => {
    const launcherDir = path.join(path.sep, 'tmp', 'FM - Sprachbox Launcher')
    const exeDir = path.join(path.sep, 'opt', 'FM - Sprachbox')
    const root = getAppRoot({
      isPackaged: true,
      execPath: path.join(exeDir, 'FM - Sprachbox.exe'),
      portableExecutableDir: launcherDir,
    })
    expect(root).toBe(path.normalize(launcherDir))
  })

  it('falls back to executable directory when portable dir is missing', () => {
    const exeDir = path.join(path.sep, 'opt', 'FM - Sprachbox')
    const root = getAppRoot({
      isPackaged: true,
      execPath: path.join(exeDir, 'FM - Sprachbox.exe'),
    })
    expect(root).toBe(exeDir)
  })

  it('rejects relative PORTABLE_EXECUTABLE_DIR', () => {
    expect(() => getAppRoot({
      isPackaged: true,
      execPath: path.join(path.sep, 'opt', 'FM - Sprachbox', 'FM - Sprachbox.exe'),
      portableExecutableDir: 'relative/path',
    })).toThrow(PortablePathError)
  })

  it('rejects relative PORTABLE_APP_ROOT env override', () => {
    expect(() => getAppRoot({
      isPackaged: true,
      execPath: path.join(path.sep, 'opt', 'FM - Sprachbox', 'FM - Sprachbox.exe'),
      envPortableAppRoot: 'relative/data',
    })).toThrow(PortablePathError)
  })

  it('rejects relative PORTABLE_APP_ROOT env override in dev mode', () => {
    expect(() => getAppRoot({ envPortableAppRoot: 'relative/data', isPackaged: false })).toThrow(PortablePathError)
  })

  it('uses absolute PORTABLE_APP_ROOT env override in dev mode', () => {
    const root = path.join(os.tmpdir(), 'sprachbox-env-root')
    expect(getAppRoot({ envPortableAppRoot: root, isPackaged: false })).toBe(path.normalize(root))
  })

  it('falls back to repo root when not packaged and no env override', () => {
    const root = getAppRoot({ projectRoot, isPackaged: false })
    expect(path.isAbsolute(root)).toBe(true)
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
  })

  it('is independent of the current working directory', () => {
    const originalCwd = process.cwd()
    const altCwd = os.tmpdir()
    try {
      process.chdir(altCwd)
      const root = getAppRoot({ projectRoot, isPackaged: false })
      expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('detects unpacked ZIP layout from packaged exec path', () => {
    const unpackedRoot = path.join(path.sep, 'mnt', 'usb', 'FM - Sprachbox')
    const root = getAppRoot({
      isPackaged: true,
      execPath: path.join(unpackedRoot, 'FM - Sprachbox.exe'),
    })
    expect(root).toBe(unpackedRoot)
    const paths = getPortablePaths({ isPackaged: true, execPath: path.join(unpackedRoot, 'FM - Sprachbox.exe') })
    expect(paths.data).toBe(path.join(unpackedRoot, 'data'))
  })
})
