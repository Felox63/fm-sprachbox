import { Tray, Menu, nativeImage, type BaseWindow, type App } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface TrayController {
  tray: Tray | null
  isQuitting: boolean
  showWindow: () => void
  quitApp: () => void
  destroy: () => void
  setMinimizeToTray?: (value: boolean) => void
  updateMenu?: () => void
  ensureTray?: () => Tray | null
}

interface CreateTrayOptions {
  app: App
  window: BaseWindow
  getMinimizeToTray: () => boolean
  onMinimizeToTrayChanged: (value: boolean) => void
  onShowWindow: () => void
}

function loadTrayIcon (): Electron.NativeImage | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'branding', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'branding', 'icon.png'),
    path.join(__dirname, '..', '..', 'assets', 'branding', 'fm-sprachbox-logo-concept.png'),
  ]
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate)
      // Electron can return an empty NativeImage instead of throwing when a
      // file is missing or unsupported, so we must inspect it before use.
      if (!image.isEmpty()) return image
    } catch {
      // try next
    }
  }
  return null
}

/**
 * Create a tray icon and context menu. The tray is only created when needed.
 * If the tray cannot be created (e.g. missing icon or unsupported environment),
 * the controller still works: minimize-to-tray falls back to quitting, and
 * explicit quit always terminates all processes cleanly.
 */
export function createTrayController (options: CreateTrayOptions): TrayController {
  const { app, window, getMinimizeToTray, onMinimizeToTrayChanged, onShowWindow } = options
  let tray: Tray | null = null
  let isQuitting = false

  function showWindow (): void {
    onShowWindow()
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  function quitApp (): void {
    isQuitting = true
    if (!window.isDestroyed()) {
      try {
        window.close()
      } catch (err) {
        console.warn('[tray] Error closing window:', err)
      }
    }
    app.quit()
  }

  function buildContextMenu (): Menu {
    return Menu.buildFromTemplate([
      {
        label: 'Öffnen',
        click: showWindow,
      },
      { type: 'separator' },
      {
        label: 'Im Hintergrund weiterlaufen',
        type: 'checkbox',
        checked: getMinimizeToTray(),
        click: (menuItem) => {
          onMinimizeToTrayChanged(menuItem.checked)
        },
      },
      { type: 'separator' },
      {
        label: 'Beenden',
        click: quitApp,
      },
    ])
  }

  function ensureTray (): Tray | null {
    if (tray != null && !tray.isDestroyed()) return tray
    const icon = loadTrayIcon()
    if (icon == null) {
      console.warn('[tray] No usable tray icon found')
      return null
    }
    try {
      tray = new Tray(icon)
    } catch (err) {
      console.warn('[tray] Could not create tray:', err)
      return null
    }
    tray.setToolTip('FM - Sprachbox')
    tray.setContextMenu(buildContextMenu())
    tray.on('click', showWindow)
    return tray
  }

  function destroy (): void {
    if (tray != null && !tray.isDestroyed()) {
      tray.destroy()
    }
    tray = null
  }

  function updateMenu (): void {
    if (tray != null && !tray.isDestroyed()) {
      tray.setContextMenu(buildContextMenu())
    }
  }

  function setMinimizeToTray (value: boolean): void {
    onMinimizeToTrayChanged(value)
    updateMenu()
  }

  ensureTray()

  return {
    get tray () { return tray },
    get isQuitting () { return isQuitting },
    set isQuitting (value: boolean) { isQuitting = value },
    showWindow,
    quitApp,
    destroy,
    // Exposed for tests and runtime updates.
    setMinimizeToTray,
    updateMenu,
    ensureTray,
  } as unknown as TrayController
}
