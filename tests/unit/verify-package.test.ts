import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import AdmZip from 'adm-zip'
import {
  PackageVerificationError,
  normalizeEntryName,
  assertNoForbiddenEntries,
  assertContainsExecutable,
  listExeEntries,
  listZipEntries,
  parse7zList,
} from '../../scripts/verify-package.mjs'

const tempDir = path.join(os.tmpdir(), `sprachbox-verify-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(tempDir, { recursive: true })
})

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe('verify-package helpers', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeEntryName('foo\\bar\\baz')).toBe('foo/bar/baz')
    expect(normalizeEntryName('foo\\bar')).toBe('foo/bar')
    expect(normalizeEntryName('foo/bar')).toBe('foo/bar')
  })

  it('detects forbidden entries in package', () => {
    expect(() => assertNoForbiddenEntries([
      'FM - Sprachbox.exe',
      'resources/app.asar',
    ])).not.toThrow()

    expect(() => assertNoForbiddenEntries([
      'FM - Sprachbox.exe',
      'data/profiles/whatsapp/Cookies',
    ])).toThrow(/Forbidden entries found/)

    expect(() => assertNoForbiddenEntries([
      'FM - Sprachbox.exe',
      'logs/main.log',
    ])).toThrow(/Forbidden entries found/)

    expect(() => assertNoForbiddenEntries([
      'FM - Sprachbox.exe',
      'resources/app/main.js.map',
    ])).toThrow(/Forbidden entries found/)
  })

  it('requires an executable with the product name', () => {
    expect(() => assertContainsExecutable(['FM - Sprachbox.exe'])).not.toThrow()
    expect(() => assertContainsExecutable(['FM-Sprachbox.exe'])).not.toThrow()
    expect(() => assertContainsExecutable(['some-other.exe'])).toThrow(/No FM - Sprachbox\.exe found/)
  })
})

describe('verify-package ZIP verification', () => {
  function makeZip (entries: Record<string, string>): string {
    const zip = new AdmZip()
    for (const [name, content] of Object.entries(entries)) {
      zip.addFile(name, Buffer.from(content))
    }
    const zipPath = path.join(tempDir, 'test.zip')
    zip.writeZip(zipPath)
    return zipPath
  }

  it('lists entries from a valid ZIP', () => {
    const zipPath = makeZip({
      'FM - Sprachbox.exe': 'exe',
      'resources/app.asar': 'asar',
      'resources/renderer/index.html': 'html',
    })
    const { names, source } = listZipEntries(zipPath)
    expect(source).toBe('admzip')
    expect(names).toContain('FM - Sprachbox.exe')
    expect(names).toContain('resources/app.asar')
  })

  it('rejects a ZIP that contains forbidden entries', () => {
    const zipPath = makeZip({
      'FM - Sprachbox.exe': 'exe',
      'data/profiles/whatsapp/Cookies': 'cookies',
    })
    expect(() => listZipEntries(zipPath)).not.toThrow()
    const { names } = listZipEntries(zipPath)
    expect(() => assertNoForbiddenEntries(names)).toThrow(PackageVerificationError)
    expect(() => assertNoForbiddenEntries(names)).toThrow(/Forbidden entries found/)
  })

  it('rejects a ZIP without a product executable', () => {
    const zipPath = makeZip({
      'resources/app.asar': 'asar',
    })
    const { names } = listZipEntries(zipPath)
    expect(() => assertContainsExecutable(names)).toThrow(PackageVerificationError)
    expect(() => assertContainsExecutable(names)).toThrow(/No FM - Sprachbox\.exe found/)
  })

  it('rejects a ZIP that contains an injected fake cookie file', () => {
    const zipPath = makeZip({
      'FM - Sprachbox.exe': 'exe',
      'resources/app.asar': 'asar',
      'data/profiles/whatsapp/Cookies': 'fake-cookie-injection',
    })
    const { names } = listZipEntries(zipPath)
    expect(() => assertNoForbiddenEntries(names)).toThrow(PackageVerificationError)
    expect(() => assertNoForbiddenEntries(names)).toThrow(/Forbidden entries found/)
  })

  it('rejects a plain archive that contains source maps', () => {
    const zipPath = makeZip({
      'FM - Sprachbox.exe': 'exe',
      'resources/app/main.js.map': '{}',
    })
    const { names } = listZipEntries(zipPath)
    expect(() => assertNoForbiddenEntries(names)).toThrow(PackageVerificationError)
  })
})

describe('verify-package EXE verification', () => {
  const listing = (names: string[]) => '7-Zip\nPath = archive.exe\nType = Nsis\n\n----------\n' +
    names.map(name => `Path = ${name}\nSize = 12\nAttributes = A\n`).join('\n')
  const resolve = () => '/controlled/7z'

  it('fails deterministically when the resolver cannot find 7z', () => {
    const run = vi.fn()
    expect(() => listExeEntries('app.exe', {
      resolve: () => { throw new PackageVerificationError('7z tool not found') }, run,
    })).toThrow(/tool not found/)
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    { code: 'ENOENT', message: 'executable disappeared' },
    { status: 2, message: 'invalid archive', stderr: 'broken archive' },
    { status: 2, message: 'partial failure', stdout: listing(['FM - Sprachbox.exe']) },
  ])('rejects a failed subprocess even with usable stdout: %j', (error) => {
    const run = vi.fn(() => { throw error })
    expect(() => listExeEntries('app.exe', { resolve, run })).toThrow(/7z listing failed/)
    expect(run).toHaveBeenCalledOnce()
  })

  it('executes the production parser preserving complete names and safe arguments', () => {
    const names = ['FM - Sprachbox.exe', 'resources/', 'resources/2026 10 notes.txt', 'resources/files, 42.txt']
    const run = vi.fn(() => listing(names))
    expect(listExeEntries('FM ; Sprachbox.exe', { resolve, run }).names).toEqual(names)
    expect(run.mock.calls[0]).toEqual([
      '/controlled/7z', ['l', '-slt', '--', 'FM ; Sprachbox.exe'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ])
  })

  it('accepts structured CRLF entries and unknown NSIS sizes, ignoring the archive header', () => {
    const output = 'Path = private archive.exe\r\nType = Nsis\r\n\r\n----------\r\n' +
      'Path = resources\\2026 10 notes.txt\r\nSize = \r\nPacked Size = 10\r\n\r\n' +
      'Path = resources\r\nSize = 0\r\nFolder = +\r\n'
    expect(parse7zList(output)).toEqual(['resources/2026 10 notes.txt', 'resources'])
  })

  it.each(['', '73 files', '----------\n', '----------\nPath = x\n',
    '----------\nPath = x\nSize = 2\n73 files',
    '----------\nPath = x\nPath = y\nSize = 2'])('rejects empty or malformed listings: %j', output => {
    expect(() => listExeEntries('app.exe', { resolve, run: () => output })).toThrow(PackageVerificationError)
  })

  it('rejects the numeric-name cookie regression without losing its data prefix', () => {
    expect(parse7zList(listing(['data/2026 10 Cookies']))).toEqual(['data/2026 10 Cookies'])
    expect(() => listExeEntries('app.exe', {
      resolve, run: () => listing(['FM - Sprachbox.exe', 'data/2026 10 Cookies']),
    })).toThrow(/Forbidden entries/)
  })

  it('lists a nested ZIP fixture through real 7z (not a real NSIS installer)', () => {
    // ZIP fixtures exercise extraction; actual NSIS verification is a separate CLI check.
    const payloadPath = path.join(tempDir, 'app-64.7z')
    const wrapperPath = path.join(tempDir, 'FM-Sprachbox.exe')

    const payload = new AdmZip()
    payload.addFile('FM - Sprachbox.exe', Buffer.from('fake exe'))
    payload.addFile('resources/app.asar', Buffer.from('asar'))
    payload.writeZip(payloadPath)

    const wrapper = new AdmZip()
    wrapper.addFile('$PLUGINSDIR/app-64.7z', fs.readFileSync(payloadPath))
    wrapper.addFile('$PLUGINSDIR/System.dll', Buffer.from('dll'))
    wrapper.writeZip(wrapperPath)

    const { names, source } = listExeEntries(wrapperPath)
    expect(source).toBe('7z')
    expect(names).toContain('FM - Sprachbox.exe')
    expect(names).toContain('resources/app.asar')
  })
})
