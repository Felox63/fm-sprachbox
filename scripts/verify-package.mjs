import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'

/**
 * Resolve a binary name against PATH without shell interpolation.
 * @param {string} binary
 * @returns {string | null}
 */
function whichBinary (binary) {
  if (path.isAbsolute(binary)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK)
      return binary
    } catch {
      return null
    }
  }
  const paths = (process.env.PATH ?? '').split(PATH_SEPARATOR).filter(Boolean)
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of paths) {
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext.toLowerCase())
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // try next candidate
      }
    }
  }
  return null
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
void __dirname // module may be imported by tests; __dirname kept for clarity

class PackageVerificationError extends Error {
  constructor (message) {
    super(message)
    this.name = 'PackageVerificationError'
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail (message) {
  throw new PackageVerificationError(message)
}

/**
 * Ensure the 7z executable exists and is executable.
 * @param {string} binary
 * @returns {string}
 */
function resolveSevenZip (binary) {
  const resolved = whichBinary(binary)
  if (!resolved) {
    fail(`7z tool not found or not executable: ${binary}. Install p7zip / 7-Zip to verify self-extracting executables.`)
  }
  return resolved
}

/**
 * Normalize archive entry names so Windows backslashes are always represented
 * as forward slashes, including single backslashes and mixed paths.
 * @param {string} name
 * @returns {string}
 */
function normalizeEntryName (name) {
  return name.replace(/\\+/g, '/')
}

/**
 * List entries of a self-extracting .exe using the system 7z tool.
 * Uses execFileSync with an argument array to avoid shell injection.
 * @param {string} exePath
 * @returns {{ names: string[], source: '7z' }}
 */
function listExeEntries (exePath, { resolve = resolveSevenZip, run = execFileSync } = {}) {
  const binary = process.platform === 'win32' ? '7z.exe' : '7z'
  const sevenZip = resolve(binary)

  let listOutput
  try {
    listOutput = run(sevenZip, ['l', '-slt', '--', exePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    const listError = String(err.stderr ?? err.stdout ?? err.message ?? err)
    fail(`7z listing failed: ${listError}`)
  }

  const topLevelNames = parse7zList(listOutput)
  assertNoForbiddenEntries(topLevelNames)

  // electron-builder portable EXEs are NSIS installers that contain the real
  // application payload inside a nested 7z archive (app-32.7z / app-64.7z).
  // Verify the payload instead of the installer shell.
  const payloadEntry = topLevelNames.find((n) => /^\$PLUGINSDIR\/app-(32|64)\.7z$/.test(n))
  if (payloadEntry) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprachbox-verify-'))
    try {
      run(sevenZip, ['e', `-o${tmpDir}`, '--', exePath, payloadEntry], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      const payloadPath = path.join(tmpDir, path.basename(payloadEntry))
      if (!fs.existsSync(payloadPath)) {
        fail(`Could not extract nested payload ${payloadEntry} from ${exePath}`)
      }
      const payloadList = run(sevenZip, ['l', '-slt', '--', payloadPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      const names = parse7zList(payloadList)
      if (names.length === 0) {
        fail(`Nested payload ${payloadEntry} produced no entries`)
      }
      return { names, source: '7z' }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  if (topLevelNames.length === 0) {
    fail('7z listing produced no entries')
  }

  return { names: topLevelNames, source: '7z' }
}

/**
 * Parse only structured `7z l -slt` entries after the archive header.
 * Preserve the complete Path value; never infer names from numeric columns.
 * Reject missing separators and malformed records rather than guessing.
 * @param {string} output
 * @returns {string[]}
 */
function parse7zList (output) {
  const lines = output.split(/\r?\n/)
  const separator = lines.indexOf('----------')
  if (separator < 0) fail('Invalid structured 7z listing: missing entry separator')
  const records = lines.slice(separator + 1).join('\n').split(/\n\s*\n/)
    .filter(record => record.trim() !== '' && !/^Warnings: \d+\s*$/.test(record))
  if (records.length === 0) fail('7z listing produced no entries')
  return records.map((record) => {
    const fields = new Map()
    for (const line of record.split('\n')) {
      if (line === '') continue
      const match = /^([^=]+?) = (.*)$/.exec(line)
      if (!match || fields.has(match[1])) fail('Invalid structured 7z entry')
      fields.set(match[1], match[2])
    }
    const name = fields.get('Path')
    // NSIS entries can have an unknown (empty) Size; the field must exist.
    if (!name || !fields.has('Size')) fail('Invalid structured 7z entry: missing Path or Size')
    return normalizeEntryName(name)
  })
}

/**
 * List entries of a plain ZIP using adm-zip.
 * @param {string} zipPath
 * @returns {{ names: string[], source: 'admzip' }}
 */
function listZipEntries (zipPath) {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  const names = entries.map((e) => normalizeEntryName(e.entryName))
  return { names, source: 'admzip' }
}

/**
 * Verify the package does not contain user data, source maps or dev files.
 * @param {string[]} names
 */
function assertNoForbiddenEntries (names) {
  const forbiddenPatterns = [
    /(^|\/)data\//,
    /(^|\/)logs\//,
    /(^|\/)profiles\//,
    /(^|\/)cookies\//,
    /(^|\/)\.env/,
    /(^|\/)\.hermes\//,
    /(^|\/)\.dev-data\//,
    /(^|\/)\.tmp\//,
    /IDEA\.md$/,
    /\.map$/,
  ]
  const forbidden = names.filter((n) => forbiddenPatterns.some((p) => p.test(n)))
  if (forbidden.length > 0) {
    fail(`Forbidden entries found:\n${forbidden.join('\n')}`)
  }
}

/**
 * @param {string[]} names
 */
function assertContainsExecutable (names) {
  const exe = names.find((n) => /FM[- ]+Sprachbox.*\.exe$/i.test(n))
  if (!exe) fail('No FM - Sprachbox.exe found in package')
  console.info(`Executable: ${exe}`)
}

async function main () {
  const zipPath = process.argv[2]
  if (!zipPath) {
    console.error('Usage: npm run verify:package -- <zip-path>')
    process.exit(1)
  }

  const absoluteZip = path.resolve(zipPath)
  if (!fs.existsSync(absoluteZip)) {
    console.error(`ZIP not found: ${absoluteZip}`)
    process.exit(1)
  }

  const isSelfExtracting = absoluteZip.toLowerCase().endsWith('.exe')

  let result
  try {
    if (isSelfExtracting) {
      result = listExeEntries(absoluteZip)
    } else {
      result = listZipEntries(absoluteZip)
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  const { names, source } = result
  console.info(`Entries (${source}): ${names.length}`)

  try {
    assertContainsExecutable(names)
    assertNoForbiddenEntries(names)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  console.info('Package verification passed')
}

// Only run the CLI when this module is executed directly, not when imported
// by unit tests. In Node ESM there is no import.meta.main, so we compare the
// file URL of the invoked script with this module's URL.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export {
  PackageVerificationError,
  normalizeEntryName,
  assertNoForbiddenEntries,
  assertContainsExecutable,
  listExeEntries,
  listZipEntries,
  parse7zList,
}
