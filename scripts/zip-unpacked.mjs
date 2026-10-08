import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

const projectRoot = process.cwd()
const unpackedDir = path.join(projectRoot, 'dist', 'win-unpacked')
const outZip = path.join(projectRoot, 'dist', 'FM-Sprachbox-win64.zip')

if (!fs.existsSync(unpackedDir)) {
  console.error('win-unpacked directory not found; run npm run dist:win first')
  process.exit(1)
}

const zip = new AdmZip()
zip.addLocalFolder(unpackedDir, 'FM - Sprachbox')
zip.writeZip(outZip)
console.info(`Created ${outZip}`)
