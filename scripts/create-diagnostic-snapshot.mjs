import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
void __dirname

const projectRoot = process.cwd()
const version = '1.2.0-telegram-fix.1'
const snapshotName = `FM-Sprachbox-Windows-${version}`
const snapshotRoot = path.join(projectRoot, 'artifacts', 'windows', snapshotName)

const excludeNames = new Set([
  'node_modules',
  'dist',
  'out',
  'data',
  'logs',
  'cache',
  'temp',
  'artifacts',
  '.backup',
  '.hermes',
  '.git',
  'review-e85196df',
  'review-evidence',
])

const excludePrefixes = [
  'backup-',
  'REPORT-',
  'review-',
  '.review-',
  'notification-',
  'HANDOFF-',
  'PLAN-',
  'ARBEITSAUFTRAG-',
  'README-',
  'REVIEW-',
]

const excludeExact = new Set([
  '.gitignore',
  'DIAGNOSTIC-README.md',
  'SOURCE-HASHES.json',
  'SHA256SUMS.txt',
  'CRC32SUMS.txt',
])

function shouldCopy (name) {
  if (excludeNames.has(name)) return false
  if (excludeExact.has(name)) return false
  if (excludePrefixes.some((p) => name.startsWith(p))) return false
  return true
}

function copyDir (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!shouldCopy(entry.name)) continue
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath)
    } else {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}


function computeSha256 (filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function computeCrc32 (filePath) {
  const zip = new AdmZip()
  zip.addFile('dummy', fs.readFileSync(filePath))
  const entry = zip.getEntries()[0]
  return entry.header.crc.toString(16).padStart(8, '0').toUpperCase()
}

function writeDiagnosticReadme () {
  const text = `# FM - Sprachbox Fokus-Diagnose-Build ${version}

Dieser Build enthält eine gezielte Korrektur des Lade-Overlays: Hintergrund- und Same-document-Ladeaktivität blendet die Messenger-Ansicht nicht mehr aus. Die Wirksamkeit gegen das konkrete Windows-Symptom muss Felix bestätigen. Die Diagnose ist weiterhin optional und standardmäßig aus.
Er enthält die gleiche Codebasis wie der normale Build, zusätzlich aber eine datensparsame, manuell aktivierbare Fokus-Protokollierung.

## Wichtig vor dem Start

1. **Separater Ordner:** Entpacke das ZIP in einen eigenen Ordner, z.B. \\\\Benutzer\\Felix\\Desktop\\FM-Sprachbox-Diagnose. Nach dem Entpacken liegt der App-Ordner \\\\FM - Sprachbox\\ darin.
2. **Nur eine Instanz gleichzeitig:** Schließe den normalen FM - Sprachbox-Build, solange die Diagnose läuft. Öffne nicht dieselben Profile in zwei Fenstern gleichzeitig.
3. **Daten als gesicherte Kopie:** Wenn du bestehende Konten/Einstellungen verwenden willst, kopiere den Inhalt des bisherigen App-Daten-Ordners (der Ordner \\\\data\\ neben der normalen EXE) in den Unterordner **FM - Sprachbox/data** direkt neben der Diagnose-EXE (nicht ins äußere Entpackverzeichnis). Behalte dein Original unverändert als Backup.
4. **Konten-Sortierung noch nicht freigegeben:** Die im Build enthaltene Möglichkeit, Konten per Pfeil zu sortieren, ist noch nicht endgültig abgenommen. Nutze sie nicht, während du die Diagnose machst.
5. **Nichts Teilen außer dem Diagnosefile:** Das Protokoll enthält keine Nachrichteninhalte, keine Tastenwerte, keine URLs, keine Kontonamen und keine Pfade. Trotzdem reicht es aus, um das Fokusverhalten nachzuvollziehen.

## Start / Stop der Diagnose

1. Starte \\\\FM - Sprachbox.exe\\ im entpackten Ordner \\\\FM - Sprachbox\\.
2. Klicke in der App auf **Startseite** (oben links im Menü).
3. Scrolle zum Abschnitt **Fokus-Diagnose**.
4. Klicke auf **Diagnose starten**. Es erscheint der Dateipfad der aktiven Protokolldatei.
5. Wechsle zu Telegram, klicke ins Eingabefeld und tippe ein paar Zeichen ungesendeten Text.
6. Wenn das Problem auftritt (Emoji-Menü, zusätzliche Klicks nötig etc.), klicke zurück zur Startseite und dann **Diagnose stoppen**.
7. Notiere den angezeigten Dateipfad.

## Datei finden und senden

1. Die Protokolldatei liegt im Unterordner **data\\logs\\** neben der EXE, z.B. \\\\...\\FM - Sprachbox\\data\\logs\\focus-diagnostic-YYYY-MM-DDTHH-MM-SS.log\\.
2. Kopiere die neueste **focus-diagnostic-*.log**-Datei.
3. Sende ausschließlich diese eine Datei weiter. Sie ist lokal auf maximal 2 MB begrenzt und enthält nur grobe Ereigniskategorien.

## Was das Protokoll enthält (und was nicht)

Enthalten:
- Fenster-Fokus/Blur
- Aktive View (Startseite / Messenger) als anonymes view-N-Label
- Sichtbarkeit des Messenger-Overlays
- Grobe Klick-Zielkategorie (editable / button / other)
- Ob ein editierbares Element fokussiert ist
- Tastatur-Eventart (keydown / keyup), aber keine Tastenwerte
- Zoom-Faktor-Änderungen
- Relative Zeit in Millisekunden seit Diagnosestart (monoton)

Nicht enthalten:
- Nachrichtentexte
- Getippte Zeichen oder Tasten
- URLs, hrefs, Chatnamen
- Account-Namen/IDs
- Cookies, Tokens
- Vollständige DOM-Attribute
- Netzwerk-Upload (das Protokoll bleibt lokal)

## Version

- Build: ${version}
- Snapshot-Pfad: ${snapshotRoot}
- ZIP: dist/FM-Sprachbox-${version}-portable-win64.zip
`
  fs.writeFileSync(path.join(snapshotRoot, 'DIAGNOSTIC-README.md'), text)
}

function buildSourceHashes () {
  const hashes = {}
  function walk (dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
      } else {
        hashes[rel] = computeSha256(full)
      }
    }
  }
  walk(snapshotRoot, '')
  fs.writeFileSync(path.join(snapshotRoot, 'SOURCE-HASHES.json'), JSON.stringify(hashes, Object.keys(hashes).sort(), 2) + '\n')
}

function packageHashes (zipPath) {
  const sha256 = computeSha256(zipPath)
  const crc32 = computeCrc32(zipPath)
  const size = fs.statSync(zipPath).size
  const shaFile = path.join(path.dirname(zipPath), 'SHA256SUMS.txt')
  const crcFile = path.join(path.dirname(zipPath), 'CRC32SUMS.txt')
  fs.writeFileSync(shaFile, `${sha256}  ${path.basename(zipPath)}\n`)
  fs.writeFileSync(crcFile, `${crc32}  ${path.basename(zipPath)} (${size} bytes)\n`)
  return { sha256, crc32, size }
}

if (fs.existsSync(snapshotRoot)) throw new Error('Snapshot already exists; preserve it instead of overwriting')
fs.mkdirSync(snapshotRoot, { recursive: true })
for (const name of ['src', 'assets', 'scripts', 'tests']) copyDir(path.join(projectRoot, name), path.join(snapshotRoot, name))
for (const name of fs.readdirSync(projectRoot)) {
  if (['package.json', 'package-lock.json', 'index.html'].includes(name) || /^(tsconfig.*\.json|vite\.config\..*|vitest\.config\..*|eslint\.config\..*)$/.test(name)) {
    fs.copyFileSync(path.join(projectRoot, name), path.join(snapshotRoot, name))
  }
}

// Update version in snapshot package.json.
const pkgPath = path.join(snapshotRoot, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
const lockPath = path.join(snapshotRoot, 'package-lock.json')
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
lock.version = version
if (lock.packages?.['']) lock.packages[''].version = version
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

writeDiagnosticReadme()
buildSourceHashes()

// Build in snapshot.
console.info(`Installing dependencies in ${snapshotRoot}...`)
execFileSync('npm', ['ci', '--include=dev'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('npx', ['electron', '--version'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('npm', ['run', 'lint'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('npm', ['run', 'typecheck'], { cwd: snapshotRoot, stdio: 'inherit' })

console.info('Building snapshot...')
// Build only the unpacked Windows directory to avoid signtool.exe signing
// hangs on non-Windows build hosts, then zip the unpacked tree ourselves.
execFileSync('npm', ['run', 'build'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('npm', ['run', 'test:unit'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('npx', ['electron-builder', '--win', '--dir'], { cwd: snapshotRoot, stdio: 'inherit' })
execFileSync('node', ['scripts/zip-unpacked.mjs'], { cwd: snapshotRoot, stdio: 'inherit' })

// The zip script writes dist/FM-Sprachbox-win64.zip; rename to versioned name.
const builtZip = path.join(snapshotRoot, 'dist', 'FM-Sprachbox-win64.zip')
const versionedZip = path.join(snapshotRoot, 'dist', `FM-Sprachbox-${version}-portable-win64.zip`)
fs.renameSync(builtZip, versionedZip)

const { sha256, crc32, size } = packageHashes(versionedZip)

console.info(`Snapshot ready at ${snapshotRoot}`)
console.info(`ZIP: ${versionedZip}`)
console.info(`SHA256: ${sha256}`)
console.info(`CRC32:  ${crc32}`)
console.info(`Size:   ${size}`)
