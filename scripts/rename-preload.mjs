import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outDir = path.join(projectRoot, 'out', 'preload')

function renamePreload (srcName, dstName) {
  const src = path.join(outDir, srcName)
  const dst = path.join(outDir, dstName)
  if (!fs.existsSync(src)) {
    // Tolerate missing source when only one preload is being built.
    console.info(`Skipping rename: ${src} does not exist`)
    return
  }
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { force: true })
  }
  fs.renameSync(src, dst)
  console.info(`Renamed preload bundle to ${dst}`)
}

renamePreload('preload.js', 'preload.cjs')
renamePreload('messenger-preload.js', 'messenger-preload.cjs')
