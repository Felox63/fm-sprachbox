import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outDir = path.join(projectRoot, 'out')
const assetsDir = path.join(projectRoot, 'assets')
const outAssetsDir = path.join(outDir, 'assets')
const rendererAssetsDir = path.join(outDir, 'renderer', 'assets')

/**
 * @param {string} src
 * @param {string} dest
 */
function copyDir (src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

if (fs.existsSync(assetsDir)) {
  copyDir(assetsDir, outAssetsDir)
  // Also copy into the renderer output so relative asset paths from
  // out/renderer/index.html (e.g. assets/service-icons/...) resolve at runtime.
  copyDir(assetsDir, rendererAssetsDir)
  console.info(`Copied assets to ${outAssetsDir} and ${rendererAssetsDir}`)
} else {
  console.warn('No assets directory found, skipping copy')
}