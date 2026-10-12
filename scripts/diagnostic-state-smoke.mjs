// Real Electron state/bridge smoke, NOT a Telegram or native-input reproducer.
import { app, BaseWindow, WebContentsView } from 'electron'
import { FocusDiagnosticLogger } from '../out/main/focus-diagnostic.js'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
async function main () {
const logsDir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'diagnostic-smoke-'))
const key = path.join(logsDir, 'fixture-key.pem')
const cert = path.join(logsDir, 'fixture-cert.pem')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<textarea autofocus></textarea>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `https://127.0.0.1:${server.address().port}`
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  if (new URL(url).origin === origin) { event.preventDefault(); callback(true) }
  else callback(false)
})

const window = new BaseWindow({ width: 600, height: 400 })
const view = new WebContentsView({ webPreferences: { preload: path.resolve('out/preload/messenger-preload.cjs'), sandbox: true, contextIsolation: true } })
window.contentView.addChildView(view)
view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
const wc = view.webContents
const logger = new FocusDiagnosticLogger({ logsDir, getActiveAccountId: () => 'fixture', getShellView: () => null, isMessengerWebContents: sender => sender === wc, isServiceUrl: url => new URL(url).origin === origin, notifyState: () => {} })
let exitCode = 0
try {
  logger.bindWindow(window)
  logger.bindMessengerWebContents(wc, 'fixture')
  await wc.loadURL(origin)
  logger.logMessengerVisible('fixture', true)
  logger.logBounds(view.getBounds())
  logger.start()
  wc.focus()
  wc.setZoomFactor(1.25)
  await wc.executeJavaScript('document.querySelector("textarea").focus()')
  await new Promise(resolve => setTimeout(resolve, 350))
  const state = logger.getState()
  let lines = fs.readFileSync(state.filePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert(lines.some(e => e.type === 'wc-focus' && e.detail.isFocused === wc.isFocused()))
  assert(lines.some(e => e.type === 'zoom' && e.detail.zoomFactor === wc.getZoomFactor()))
  const reloaded = new Promise(resolve => wc.once('did-finish-load', resolve))
  wc.reload()
  await reloaded
  await wc.executeJavaScript('document.querySelector("textarea").blur(); document.querySelector("textarea").focus()')
  await new Promise(resolve => setTimeout(resolve, 200))
  lines = fs.readFileSync(state.filePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert(lines.some(e => e.type === 'dom-focusin'))
  logger.stop()
  const stopped = fs.readFileSync(state.filePath, 'utf8')
  await wc.executeJavaScript('document.querySelector("textarea").blur(); document.querySelector("textarea").focus()')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(fs.readFileSync(state.filePath, 'utf8'), stopped)
  console.info(JSON.stringify({ passed: true, scope: 'real Electron isFocused/getZoomFactor and private preload reload/stop', nativeTelegramInput: false }))
} catch (error) { console.error(error); exitCode = 1 }
finally { logger.stop(); logger.unbindMessengerWebContents(wc); window.destroy(); server.close(); fs.rmSync(logsDir, { recursive: true, force: true }); app.exit(exitCode) }
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1) })
