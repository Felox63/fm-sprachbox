import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<number>}
 */
function run (cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function main () {
  // Build preload once; it changes rarely and must exist before Electron starts.
  const preload = await run('npm', ['run', 'build:preload'], projectRoot)
  if (preload !== 0) process.exit(preload)

  // Build renderer first so Electron can load it in dev mode.
  const vite = await run('npx', ['vite', 'build'], projectRoot)
  if (vite !== 0) process.exit(vite)

  const tsc = await run('npx', ['tsc', '-p', 'tsconfig.node.json', '--watch'], projectRoot)
  if (tsc !== 0) process.exit(tsc)

  const electron = await run('npx', ['electron', 'out/main/index.js'], projectRoot)
  process.exit(electron)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
