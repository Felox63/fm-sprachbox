import type { App, BaseWindow } from 'electron'
import type { TrayController } from './tray.js'
import type { RuntimeState } from './app.js'

/**
 * Register the window 'close' handler that implements close-to-tray behavior.
 * The handler is only intercepted when minimizeToTray is enabled, no explicit
 * quit is in progress, and a working tray actually exists. This keeps the test
 * surface identical to the production path in src/main/index.ts.
 */
export function registerTrayWindowCloseHandler (
  window: BaseWindow,
  trayController: TrayController | null,
  getMinimizeToTray: () => boolean,
): void {
  window.on('close', (event) => {
    if (!(getMinimizeToTray() ?? false)) {
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
      window.hide()
    }
  })
}

export interface TrayQuitCleanup {
  onTrayDestroyed?: () => void
}

/**
 * Register the app-level quit lifecycle handlers: before-quit marks the tray
 * controller so the close handler does not intercept the quit, and
 * window-all-closed cleans up the tray and views before terminating.
 */
export function registerAppTrayQuitHandlers (
  app: App,
  getTrayController: () => TrayController | null,
  runtimeState: RuntimeState,
  cleanup?: TrayQuitCleanup,
): void {
  app.on('before-quit', () => {
    const trayController = getTrayController()
    // Mark that the app is quitting so the window close handler does not
    // intercept it and leave a hidden process behind.
    if (trayController != null) {
      trayController.isQuitting = true
    }
  })

  app.on('window-all-closed', () => {
    getTrayController()?.destroy()
    cleanup?.onTrayDestroyed?.()
    runtimeState.trayController = null
    app.quit()
  })
}
