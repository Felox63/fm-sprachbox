/**
 * Reproduzierbarer Electron-Smoke-Test für Paket 2.
 *
 * Läuft als Electron-Main-Prozess (`electron scripts/p2-smoke.mjs`). Startet die
 * App-Runtime aus dem gebauten `out/`-Verzeichnis und fährt durch die Zustände
 * Startseite -> WhatsApp-Service -> produktiver Ladefehler -> klickbarer Retry
 * -> Erfolg. Prüft native Bounds, Sichtbarkeit und Bedienbarkeit. Speichert
 * Screenshots und ein JSON-Log.
 *
 * Der Fehlerzustand wird durch Emittieren des echten Electron-Ereignisses
 * `did-fail-load` auf der WhatsApp-WebContents ausgelöst. Dadurch durchläuft der
 * Test denselben Handler wie ein echter Netzwerk-/Ladefehler in der App.
 * Anschließend wird der Retry-Button über einen echten Mausklick (sendInputEvent)
 * betätigt, wodurch die IPC-Verdrahtung und native Hit-Test nachweisbar sind.
 *
 * Hinweis zu Screenshots: `BaseWindow` in der verwendeten Electron-Version hat
 * kein `capturePage()`. Home-/Overlay-Screenshots erfassen daher die Shell-View
 * (die in diesen Modi das ganze Fenster füllt). Service-/Retry-Screenshots
 * erfassen Sidebar und Messenger-Bereich separat; der Messenger-Bereich wird vor
 * dem Speichern durch eine weiße WebContentsView maskiert, damit keine QR-Codes,
 * Nachrichten oder Login-Daten persistiert werden. Eine native Gesamtfenster-
 * Komposition aus einem einzigen Capture ist ohne externe X11-Tools hier nicht
 * erreichbar; die Behauptung im Handoff beschränkt sich deshalb auf diese
 * getrennten, datensparsamen View-Captures.
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { app } from 'electron'

const RENDERER_ROOT = path.join(import.meta.dirname, '../out/renderer')
const PRELOAD_PATH = path.join(import.meta.dirname, '../out/preload', 'preload.cjs')
const ARTIFACTS_DIR = path.join(import.meta.dirname, '../artifacts')

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

async function captureWebContents (webContents, filename) {
  const image = await webContents.capturePage()
  const outPath = path.join(ARTIFACTS_DIR, filename)
  fs.writeFileSync(outPath, image.toPNG())
  return outPath
}

async function captureMaskedMessenger (mainWindow, messengerView, filename) {
  // Overlay a white WebContentsView on top of the messenger area so no remote
  // content (QR codes, messages, login state) is persisted in the screenshot.
  const { WebContentsView } = await import('electron')
  const mask = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  const messengerBounds = messengerView.getBounds()
  mask.setBounds(messengerBounds)
  mainWindow.contentView.addChildView(mask)
  await mask.webContents.loadURL('data:text/html,<!doctype html><html style="margin:0;background:#fff"><body></body></html>')
  await waitFor(() => !mask.webContents.isLoading(), { label: 'mask view load' })
  await sleep(100)

  // Capture the white mask view (same size/position as the messenger area).
  const image = await mask.webContents.capturePage()
  const outPath = path.join(ARTIFACTS_DIR, filename)
  fs.writeFileSync(outPath, image.toPNG())

  mainWindow.contentView.removeChildView(mask)
  try {
    mask.webContents.close()
  } catch {
    // ignore
  }
  return outPath
}

async function getRetryButtonCenter (shellView) {
  const rect = await shellView.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('button.primary-button')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()
  `)
  return rect
}

async function clickAt (webContents, point) {
  const { x, y } = point
  webContents.sendInputEvent({ type: 'mouseMove', x, y })
  await sleep(50)
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await sleep(50)
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(50)
}

/**
 * Cleanly shut down the smoke runtime so the temporary profile can be removed.
 * Closing the window first triggers the app's 'closed' handler, which destroys
 * messenger views/sessions. We then wait for the window to actually close and
 * remove the temp profile root.
 */
async function cleanupRuntime (runtimeState, tempRoot) {
  if (runtimeState?.mainWindow != null) {
    await Promise.race([
      new Promise((resolve) => {
        const win = runtimeState.mainWindow
        win.once('closed', resolve)
        win.close()
      }),
      sleep(10000).then(() => console.warn('[smoke] cleanup window close timeout')),
    ])
  }

  if (tempRoot != null) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch (err) {
      console.warn('[smoke] cleanup tempRoot failed:', err)
    }
  }
}

async function main () {
  let tempRoot = null
  let runtimeState = null
  let exitCode = 0

  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
    tempRoot = path.join(os.tmpdir(), `sprachbox-p2-smoke-${Date.now()}`)
    fs.mkdirSync(tempRoot, { recursive: true })

    const { createRuntime } = await import('../out/main/app.js')
    const { getPortablePaths, preparePortablePaths } = await import('../out/main/portable-paths.js')
    const { loadServiceConfig } = await import('../out/main/service-config.js')
    const { getUserAgentSource } = await import('../out/main/user-agent.js')

    const portableContext = {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      envPortableAppRoot: tempRoot,
    }
    const portablePaths = getPortablePaths(portableContext)
    preparePortablePaths(portablePaths)

    app.setPath('userData', portablePaths.data)
    app.setPath('sessionData', portablePaths.sessionData)
    app.setPath('logs', portablePaths.logs)
    app.setPath('temp', portablePaths.temp)
    app.setPath('cache', portablePaths.cache)

    const loadResult = loadServiceConfig(portablePaths)
    runtimeState = {
      mainWindow: null,
      shellView: null,
      messengers: new Map(),
      activeService: null,
      showingHome: false,
      serviceConfig: loadResult.config,
      lastConfigSaveError: loadResult.ok ? 'none' : (loadResult.createdDefaults ? 'load-write-failed' : 'toggle-write-failed'),
    }

    const userAgentSource = getUserAgentSource()
    const runtime = createRuntime({
      app,
      state: runtimeState,
      rendererRoot: RENDERER_ROOT,
      portablePaths,
      preloadPath: PRELOAD_PATH,
      userAgentSource,
    })
    runtime.registerIpc()

    await app.whenReady()
    console.info('[smoke] Chrome version:', userAgentSource.chrome)
    console.info('[smoke] Enabled services:', runtimeState.serviceConfig.enabled)
    runtime.createWindow()

    const { mainWindow, shellView } = runtimeState
    if (!mainWindow || !shellView) {
      throw new Error('Window or shell view was not created')
    }

    await waitFor(
      () => !shellView.webContents.isLoading() && shellView.webContents.getURL().includes('index.html'),
      { label: 'shell index.html load' },
    )
    runtime.showHome()
    await sleep(300)

    const initialBounds = mainWindow.getContentBounds()
    const shellBoundsHome = shellView.getBounds()
    if (shellBoundsHome.width !== initialBounds.width || shellBoundsHome.height !== initialBounds.height || shellBoundsHome.x !== 0 || shellBoundsHome.y !== 0) {
      throw new Error(`Home shell bounds mismatch: ${JSON.stringify(shellBoundsHome)} vs content ${JSON.stringify(initialBounds)}`)
    }
    const homeScreenshot = await captureWebContents(shellView.webContents, 'p2-smoke-home.png')
    console.info('[smoke] Home layout OK:', shellBoundsHome, 'screenshot:', homeScreenshot)

    // --- Service mode ---------------------------------------------------------
    runtime.showService('whatsapp')
    await waitFor(
      () => {
        const entry = runtimeState.messengers.get('whatsapp')
        return entry != null && entry.loadState.loading === false && entry.loadState.failed === false
      },
      { timeoutMs: 45000, label: 'WhatsApp initial load success' },
    )
    await sleep(300)

    const serviceBounds = mainWindow.getContentBounds()
    const shellBoundsService = shellView.getBounds()
    const messengerView = runtimeState.messengers.get('whatsapp').messenger.view
    const messengerBoundsService = messengerView.getBounds()
    const messengerVisibleService = messengerView.getVisible()

    if (shellBoundsService.width !== 220) {
      throw new Error(`Service sidebar width should be 220, got ${shellBoundsService.width}`)
    }
    if (messengerBoundsService.x !== 220) {
      throw new Error(`Service messenger x should be 220, got ${messengerBoundsService.x}`)
    }
    if (messengerBoundsService.width !== serviceBounds.width - 220) {
      throw new Error(`Service messenger width mismatch: ${messengerBoundsService.width} vs ${serviceBounds.width - 220}`)
    }
    if (!messengerVisibleService) {
      throw new Error('Messenger view should be visible in service mode')
    }
    const serviceShellScreenshot = await captureWebContents(shellView.webContents, 'p2-smoke-service-shell.png')
    const serviceMessengerScreenshot = await captureMaskedMessenger(mainWindow, messengerView, 'p2-smoke-service-messenger.png')
    console.info('[smoke] Service layout OK:', shellBoundsService, messengerBoundsService, 'visible:', messengerVisibleService, 'screenshots:', serviceShellScreenshot, serviceMessengerScreenshot)

    // --- Productive error overlay ---------------------------------------------
    // Trigger the real did-fail-load handler on the WhatsApp WebContents. This
    // is the same code path that a genuine network failure would take.
    const entry = runtimeState.messengers.get('whatsapp')
    const whatsappWc = entry.messenger.webContents
    whatsappWc.emit('did-fail-load', {}, -105, 'network error', 'https://web.whatsapp.com/', true, 1, 1)

    await waitFor(
      () => {
        const e = runtimeState.messengers.get('whatsapp')
        return e != null && e.loadState.loading === false && e.loadState.failed === true
      },
      { timeoutMs: 10000, label: 'WhatsApp error state after did-fail-load' },
    )
    await sleep(300)

    const overlayBounds = mainWindow.getContentBounds()
    const shellBoundsOverlay = shellView.getBounds()
    const messengerBoundsOverlay = messengerView.getBounds()
    const messengerVisibleOverlay = messengerView.getVisible()

    if (shellBoundsOverlay.width !== overlayBounds.width || shellBoundsOverlay.height !== overlayBounds.height) {
      throw new Error(`Overlay shell should fill window: ${JSON.stringify(shellBoundsOverlay)} vs ${JSON.stringify(overlayBounds)}`)
    }
    if (messengerBoundsOverlay.width !== 0) {
      throw new Error(`Overlay messenger width should be 0, got ${messengerBoundsOverlay.width}`)
    }
    if (messengerVisibleOverlay) {
      throw new Error('Messenger view should be hidden in overlay mode')
    }

    // Verify the renderer actually shows a clickable retry button.
    const retryButtonCenter = await getRetryButtonCenter(shellView)
    if (retryButtonCenter == null) {
      throw new Error('Retry button not found in overlay DOM')
    }
    const overlayScreenshot = await captureWebContents(shellView.webContents, 'p2-smoke-overlay.png')
    console.info('[smoke] Overlay layout OK:', shellBoundsOverlay, 'messenger visible:', messengerVisibleOverlay, 'retry button:', retryButtonCenter, 'screenshot:', overlayScreenshot)

    // --- Retry via real click on the overlay button ---------------------------
    const generationBeforeClick = entry.loadGeneration
    await clickAt(shellView.webContents, retryButtonCenter)

    await waitFor(
      () => {
        const e = runtimeState.messengers.get('whatsapp')
        return e != null && e.loadState.loading === false && e.loadState.failed === false
      },
      { timeoutMs: 45000, label: 'WhatsApp retry success' },
    )
    await sleep(500)

    const retryBounds = mainWindow.getContentBounds()
    const shellBoundsRetry = shellView.getBounds()
    const messengerBoundsRetry = messengerView.getBounds()
    const messengerVisibleRetry = messengerView.getVisible()

    if (shellBoundsRetry.width !== 220) {
      throw new Error(`Retry sidebar width should be 220, got ${shellBoundsRetry.width}`)
    }
    if (messengerBoundsRetry.x !== 220) {
      throw new Error(`Retry messenger x should be 220, got ${messengerBoundsRetry.x}`)
    }
    if (messengerBoundsRetry.width !== retryBounds.width - 220) {
      throw new Error(`Retry messenger width mismatch: ${messengerBoundsRetry.width} vs ${retryBounds.width - 220}`)
    }
    if (!messengerVisibleRetry) {
      throw new Error('Messenger view should be visible again after retry')
    }

    const entryAfterRetry = runtimeState.messengers.get('whatsapp')
    if (entryAfterRetry == null || entryAfterRetry.loadGeneration <= generationBeforeClick) {
      throw new Error(`Retry click did not trigger a new load attempt: generation ${entryAfterRetry?.loadGeneration} <= ${generationBeforeClick}`)
    }

    const retryShellScreenshot = await captureWebContents(shellView.webContents, 'p2-smoke-retry-shell.png')
    const retryMessengerScreenshot = await captureMaskedMessenger(mainWindow, messengerView, 'p2-smoke-retry-messenger.png')
    console.info('[smoke] Retry layout OK:', shellBoundsRetry, messengerBoundsRetry, 'visible:', messengerVisibleRetry, 'screenshots:', retryShellScreenshot, retryMessengerScreenshot)

    // --- JSON result ---------------------------------------------------------
    const result = {
      success: true,
      chromeVersion: userAgentSource.chrome,
      enabledServices: runtimeState.serviceConfig.enabled,
      screenshots: {
        home: homeScreenshot,
        service: { shell: serviceShellScreenshot, messenger: serviceMessengerScreenshot },
        overlay: overlayScreenshot,
        retry: { shell: retryShellScreenshot, messenger: retryMessengerScreenshot },
      },
      bounds: {
        home: shellBoundsHome,
        service: { shell: shellBoundsService, messenger: messengerBoundsService, messengerVisible: messengerVisibleService },
        overlay: { shell: shellBoundsOverlay, messenger: messengerBoundsOverlay, messengerVisible: messengerVisibleOverlay, retryButton: retryButtonCenter },
        retry: { shell: shellBoundsRetry, messenger: messengerBoundsRetry, messengerVisible: messengerVisibleRetry, loadGenerationAfter: entryAfterRetry.loadGeneration },
      },
    }
    const resultPath = path.join(ARTIFACTS_DIR, 'p2-smoke-result.json')
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.info('[smoke] Result:', resultPath)
  } catch (err) {
    console.error('[smoke] FAILED:', err)
    exitCode = 1
    try {
      fs.writeFileSync(
        path.join(ARTIFACTS_DIR, 'p2-smoke-result.json'),
        JSON.stringify({ success: false, error: String(err) }, null, 2),
      )
    } catch {
      // ignore
    }
  } finally {
    await cleanupRuntime(runtimeState, tempRoot)
    app.exit(exitCode)
  }
}

// p2-smoke.mjs is spawned by scripts/with-xvfb.mjs, which already set DISPLAY and
// started our own Xvfb. We therefore just run the Electron smoke logic and leave
// Xvfb cleanup to the wrapper.
main().catch(async (err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
