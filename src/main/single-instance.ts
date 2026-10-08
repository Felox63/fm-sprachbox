import type { App, BaseWindow } from 'electron'

/** Acquire before config/profile access; losing process never initializes data. */
export function acquireSingleInstance (app: App, getWindow: () => BaseWindow | null): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  })
  return true
}
