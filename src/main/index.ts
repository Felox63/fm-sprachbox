import { app } from 'electron'
import { acquireSingleInstance } from './single-instance.js'
import type { RuntimeState } from './app.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getPortablePaths,
  preparePortablePaths,
  getAppRoot,
  type PortableContext,
  type PortablePaths,
} from './portable-paths.js'
import { loadServiceConfig } from './service-config.js'
import { createRuntime } from './app.js'
import { getUserAgentSource } from './user-agent.js'
import { type AccountDefinition } from '../shared/accounts.js'
import { createTrayController, type TrayController } from './tray.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer')
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.cjs')

const runtimeState: RuntimeState = {
  mainWindow: null,
  shellView: null,
  messengers: new Map(),
  activeAccountId: null,
  showingHome: false,
  serviceConfig: { version: 2 as const, accounts: [] as AccountDefinition[], selectedAccountId: null as string | null, preferences: undefined },
  lastConfigSaveError: 'none' as 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly',
  trayController: null as TrayController | null,
}

let portablePaths: PortablePaths
let trayController: TrayController | null = null
const userAgentSource = getUserAgentSource()

function getPortableContext (): PortableContext {
  return {
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    envPortableAppRoot: process.env.PORTABLE_APP_ROOT,
  }
}

function showMainWindow (): void {
  const win = runtimeState.mainWindow
  if (win == null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

interface CreateTrayForWindowOptions {
  window: Electron.BaseWindow
  persistMinimizeToTray: (value: boolean) => void
}

function createTrayForWindow (options: CreateTrayForWindowOptions): TrayController {
  const { window, persistMinimizeToTray } = options
  trayController = createTrayController({
    app,
    window,
    getMinimizeToTray: () => runtimeState.serviceConfig.preferences?.minimizeToTray ?? false,
    onMinimizeToTrayChanged: (value) => {
      persistMinimizeToTray(value)
      if (!value) {
        showMainWindow()
      }
    },
    onShowWindow: showMainWindow,
  })
  runtimeState.trayController = trayController
  return trayController
}

// Set all Electron default paths BEFORE app is ready. The official API docs
// state these calls must happen before app.ready, otherwise they have no effect
// on the default session paths.
if (acquireSingleInstance(app, () => {
  showMainWindow()
  return runtimeState.mainWindow
})) {
  portablePaths = getPortablePaths(getPortableContext())
  try {
    preparePortablePaths(portablePaths)
  } catch (err) {
    console.error('[main] Failed to prepare portable paths:', err)
    app.exit(1)
  }

  app.setPath('userData', portablePaths.data)
  app.setPath('sessionData', portablePaths.sessionData)
  app.setPath('logs', portablePaths.logs)
  app.setPath('temp', portablePaths.temp)
  app.setPath('cache', portablePaths.cache)

  const loadResult = loadServiceConfig(portablePaths)
  if (!loadResult.ok) {
    // If the initial default config could not be written, still start the app but
    // warn the user through the UI. The in-memory defaults are usable.
    runtimeState.lastConfigSaveError = loadResult.isReadOnly
      ? 'future-version-readonly'
      : loadResult.createdDefaults
        ? 'load-write-failed'
        : 'save-write-failed'
  }
  runtimeState.serviceConfig = loadResult.config

  const runtime = createRuntime({
    app,
    state: runtimeState,
    rendererRoot: RENDERER_ROOT,
    portablePaths,
    preloadPath: PRELOAD_PATH,
    userAgentSource,
  })

  runtime.registerIpc()

  app.whenReady().then(() => {
    console.info('[main] App root:', getAppRoot(getPortableContext()))
    console.info('[main] Portable data:', portablePaths.data)
    console.info('[main] Accounts:', loadResult.config.accounts.length)
    console.info('[main] Chrome version:', userAgentSource.chrome)
    runtime.createWindow()
    const win = runtimeState.mainWindow
    if (win != null && !win.isDestroyed()) {
      createTrayForWindow({
        window: win,
        persistMinimizeToTray: (value) => runtime.persistConfigPreference('minimizeToTray', value),
      })
      win.on('close', (event) => {
        if (!(runtimeState.serviceConfig.preferences?.minimizeToTray ?? false)) {
          // minimizeToTray is disabled: let the close go through normally.
          return
        }
        if (trayController?.isQuitting ?? false) {
          // Explicit quit path: close normally.
          return
        }
        // Only hide to tray when a working tray actually exists; otherwise fall
        // through to normal close/quit so the process never becomes invisible.
        const tray = trayController?.ensureTray?.()
        if (tray != null && !tray.isDestroyed()) {
          event.preventDefault()
          win.hide()
        }
      })
    }
  })

  app.on('before-quit', () => {
    // Mark that the app is quitting so the window close handler does not
    // intercept it and leave a hidden process behind.
    if (trayController != null) {
      trayController.isQuitting = true
    }
  })

  app.on('window-all-closed', () => {
    trayController?.destroy()
    trayController = null
    runtimeState.trayController = null
    app.quit()
  })

  app.on('web-contents-created', (_event, webContents) => {
    // This global handler only catches popups/new windows that originate from any
    // WebContents before explicit guards are attached. Real guards are attached
    // immediately after construction in attachShellGuards / attachRemoteGuards.
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

}

export { runtimeState, portablePaths, userAgentSource }
export const serviceConfig = runtimeState.serviceConfig
