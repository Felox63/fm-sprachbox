import { spawn } from 'node:child_process'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function waitFor (predicate, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await sleep(intervalMs)
  }
  throw new Error(`Timeout waiting for: ${label}`)
}

function getXvfbLockPath (displayNum) {
  return `/tmp/.X${displayNum}-lock`
}

function isDisplayFree (displayNum) {
  const lockPath = getXvfbLockPath(displayNum)
  try {
    fs.accessSync(lockPath, fs.constants.F_OK)
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim())
    if (Number.isNaN(pid)) return false
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  } catch {
    return true
  }
}

async function waitForDisplayReady (displayNum) {
  const unixSocket = `/tmp/.X11-unix/X${displayNum}`
  await waitFor(
    () => {
      try {
        fs.accessSync(unixSocket, fs.constants.F_OK)
        return true
      } catch {
        return false
      }
    },
    { timeoutMs: 10000, label: `X11 unix socket for :${displayNum}` },
  )
  await sleep(500)
}

async function startXvfb () {
  if (process.env.SPRACHBOX_NO_XVFB) return null

  let displayNum = 99
  while (displayNum < 200) {
    if (isDisplayFree(displayNum)) break
    displayNum += 1
  }

  const child = spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1280x800x24', '-ac'], {
    stdio: 'ignore',
    detached: false,
  })

  try {
    process.env.DISPLAY = `:${displayNum}`

    await waitFor(
      () => {
        try {
          const pid = Number(fs.readFileSync(getXvfbLockPath(displayNum), 'utf8').trim())
          return pid === child.pid
        } catch {
          return false
        }
      },
      { timeoutMs: 5000, label: `Xvfb lock for :${displayNum}` },
    )
    await waitForDisplayReady(displayNum)
    await sleep(2000)
    return child
  } catch (err) {
    await stopXvfb(child)
    throw err
  }
}

async function waitForExit (child, { timeoutMs = 5000, label = 'child exit' } = {}) {
  await waitFor(
    () => child.exitCode !== null,
    { timeoutMs, label },
  )
}

async function stopXvfb (xvfb) {
  if (!xvfb) return
  try {
    xvfb.kill('SIGTERM')
    await waitForExit(xvfb, { timeoutMs: 5000, label: 'Xvfb SIGTERM exit' })
  } catch {
    try {
      xvfb.kill('SIGKILL')
      await waitForExit(xvfb, { timeoutMs: 3000, label: 'Xvfb SIGKILL exit' })
    } catch {
      // ignore
    }
  }
}

async function main () {
  const smokeScript = path.join(import.meta.dirname, 'p2-smoke.mjs')
  const electronBin = path.join(import.meta.dirname, '../node_modules/electron/dist/electron')

  let xvfb = null
  let child = null
  try {
    xvfb = await startXvfb()
    if (xvfb) {
      console.info('[with-xvfb] Xvfb started on', process.env.DISPLAY, 'pid', xvfb.pid)
    } else {
      console.info('[with-xvfb] Using existing DISPLAY:', process.env.DISPLAY)
    }
    child = spawn(electronBin, [smokeScript], { stdio: 'inherit', env: process.env })
    const code = await new Promise((resolve) => child.on('exit', resolve))
    process.exitCode = code ?? 1
  } catch (err) {
    console.error('[with-xvfb] FAILED:', err)
    if (child != null && child.exitCode == null && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    process.exitCode = 1
  } finally {
    if (child != null && child.exitCode == null && !child.killed) {
      try {
        child.kill('SIGTERM')
        await new Promise((resolve) => child.on('exit', resolve))
      } catch {
        // ignore
      }
    }
    await stopXvfb(xvfb)
  }
}

main().catch((err) => {
  console.error('[with-xvfb] FAILED:', err)
  process.exit(1)
})
