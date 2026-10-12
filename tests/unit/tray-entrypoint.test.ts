import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BaseWindow, Tray, App, WebContents, WebContentsView, BaseWindowConstructorOptions } from 'electron'
import type { TrayController } from '../../src/main/tray.js'
import type { AccountDefinition } from '../../src/shared/accounts.js'

// =============================================================================
// Test harness for src/main/index.ts (the real entrypoint).
//
// The entrypoint runs top-level: it registers app quit handlers BEFORE
// app.whenReady() resolves and only creates the TrayController afterwards.
// These integration tests exercise that exact sequence with real production
// modules (createRuntime/createTrayController/registerTrayWindowCloseHandler/
// registerAppTrayQuitHandlers/destroyMessengerView are NOT replaced).
// =============================================================================

interface FakeEvent {
  preventDefault: () => void
  defaultPrevented: boolean
}

let whenReadyResolver: (() => void) | null = null
let whenReadyPromise: Promise<void> | null = null

let iconConfig: {
  allEmpty: boolean
  firstEmpty: boolean
  constructorThrows: boolean
} = {
  allEmpty: false,
  firstEmpty: false,
  constructorThrows: false,
}

const createdTrays: Array<{
  instance: ReturnType<typeof makeTrayInstance>
  destroyed: boolean
}> = []

const trayConstructorCalls: Array<{ image: { path: string; empty: boolean } }> = []

let createdImages: Array<{ path: string; empty: boolean; isEmpty: () => boolean }> = []

let appHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}
let appOnceHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}

const mockApp: App = {
  isPackaged: false,
  requestSingleInstanceLock: vi.fn(() => true),
  setPath: vi.fn(),
  getPath: vi.fn(),
  getVersion: vi.fn(() => '44.5.0'),
  whenReady: vi.fn(() => {
    if (whenReadyPromise == null) {
      whenReadyPromise = new Promise<void>((resolve) => {
        whenReadyResolver = resolve
      })
    }
    return whenReadyPromise
  }),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (appHandlers[event] == null) appHandlers[event] = []
    appHandlers[event].push(handler)
  }),
  once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (appOnceHandlers[event] == null) appOnceHandlers[event] = []
    appOnceHandlers[event].push(handler)
  }),
  quit: vi.fn(),
  exit: vi.fn(),
  emit: (event: string, ...args: unknown[]) => {
    const list = appHandlers[event] ?? []
    for (const handler of list) {
      handler({}, ...args)
    }
  },
  _reset: () => {
    appHandlers = {}
    appOnceHandlers = {}
    whenReadyPromise = null
    whenReadyResolver = null
  },
} as unknown as App

function resolveWhenReady (): void {
  if (whenReadyResolver != null) {
    whenReadyResolver()
    whenReadyResolver = null
  }
}

function makeTrayInstance (): Tray {
  const instance = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(() => {
      const entry = createdTrays.find((t) => t.instance === instance)
      if (entry != null) entry.destroyed = true
    }),
    isDestroyed: vi.fn(() => {
      const entry = createdTrays.find((t) => t.instance === instance)
      return entry?.destroyed ?? false
    }),
  }
  createdTrays.push({ instance, destroyed: false })
  return instance as unknown as Tray
}

let baseWindowCounter = 0
const createdWindows: Array<ReturnType<typeof makeFakeWindow>> = []

function makeFakeWindow (opts?: BaseWindowConstructorOptions): BaseWindow {
  baseWindowCounter += 1
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const onceListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  let visible = opts?.show ?? true
  let minimized = false
  let destroyed = false
  let closed = false

  const win = {
    _id: baseWindowCounter,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: vi.fn(() => ({ width: 1280, height: 800 })),
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    isVisible: vi.fn(() => visible && !closed && !destroyed),
    isFocused: vi.fn(() => visible && !closed && !destroyed && !minimized),
    restore: vi.fn(() => { minimized = false }),
    show: vi.fn(() => { visible = true }),
    hide: vi.fn(() => { visible = false }),
    focus: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(handler)
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (onceListeners[event] == null) onceListeners[event] = []
      onceListeners[event].push(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event] == null) return
      listeners[event] = listeners[event].filter((h) => h !== handler)
    }),
    emit: (event: string, ...args: unknown[]) => {
      const list = listeners[event] ?? []
      for (const handler of list) {
        handler(...args)
      }
    },
    emitOnce: (event: string, ...args: unknown[]) => {
      const list = onceListeners[event] ?? []
      delete onceListeners[event]
      for (const handler of list) {
        handler(...args)
      }
    },
    close: vi.fn(() => {
      if (destroyed || closed) return
      const event: FakeEvent = {
        preventDefault: () => { event.defaultPrevented = true },
        defaultPrevented: false,
      }
      win.emit('close', event)
      if (!event.defaultPrevented) {
        closed = true
        destroyed = true
        win.emit('closed')
      }
    }),
  }
  createdWindows.push(win)
  return win as unknown as BaseWindow
}

function makeFakeWebContents (url = ''): WebContents {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const onceListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  let currentUrl = url
  let closed = false

  const makeEvent = (): FakeEvent => ({
    preventDefault: () => { /* no-op */ },
    defaultPrevented: false,
  })

  const wc: WebContents = {
    id: Math.random(),
    getURL: () => currentUrl,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(handler)
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (onceListeners[event] == null) onceListeners[event] = []
      onceListeners[event].push(handler)
    }),
    close: vi.fn(() => { closed = true }),
    loadFile: vi.fn((filePath: string) => {
      currentUrl = pathToFileURLString(filePath)
      // Electron calls the once-listener asynchronously after load.
      setTimeout(() => {
        const list = onceListeners['did-finish-load'] ?? []
        delete onceListeners['did-finish-load']
        for (const handler of list) {
          handler(makeEvent())
        }
      }, 0)
      return Promise.resolve()
    }),
    loadURL: vi.fn(() => Promise.resolve()),
    setUserAgent: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => closed),
  } as unknown as WebContents
  return wc
}

function pathToFileURLString (filePath: string): string {
  // Minimal file URL for isAllowedShellNavigation guard in tests.
  return 'file://' + filePath.replace(/\\/g, '/')
}

const createdViews: Array<{ webContents: WebContents; setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; isMessenger?: boolean }> = []

function makeFakeWebContentsView (isMessenger = false): WebContentsView {
  const wc = makeFakeWebContents()
  const view = {
    webContents: wc,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    isMessenger,
  }
  createdViews.push(view)
  // Emit the global popup-deny handler the entrypoint registers.
  mockApp.emit('web-contents-created', wc)
  return view as unknown as WebContentsView
}

let currentMenuTemplate: unknown[] = []

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron')
  return {
    ...actual,
    app: mockApp,
    BaseWindow: vi.fn((opts: BaseWindowConstructorOptions) => makeFakeWindow(opts)),
    WebContentsView: vi.fn((opts?: { webPreferences?: { session?: unknown; preload?: string } }) => {
      // The shell view has no session option; messenger views have a session.
      const isMessenger = opts?.webPreferences?.session != null
      return makeFakeWebContentsView(isMessenger)
    }),
    Tray: vi.fn((image: { path: string; empty: boolean }) => {
      trayConstructorCalls.push({ image })
      if (iconConfig.constructorThrows) {
        throw new Error('Tray constructor failed')
      }
      return makeTrayInstance()
    }),
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        currentMenuTemplate = template
        return {
          popup: vi.fn(),
          template,
        }
      }),
    },
    nativeImage: {
      createFromPath: vi.fn((imagePath: string) => {
        const isIco = imagePath.endsWith('icon.ico')
        const empty = iconConfig.allEmpty || (iconConfig.firstEmpty && isIco)
        const image = {
          path: imagePath,
          empty,
          isEmpty: () => empty,
        }
        createdImages.push(image)
        return image
      }),
    },
    screen: {
      on: vi.fn(),
      off: vi.fn(),
    },
    session: {
      fromPath: vi.fn((profileDir: string) => ({
        profileDir,
        clearStorageData: vi.fn(),
        setUserAgent: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      })),
    },
    ipcMain: {
      on: vi.fn(),
      handle: vi.fn(),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    shell: { openExternal: vi.fn() },
  }
})

vi.mock('../../src/main/portable-paths.js', () => ({
  getPortablePaths: vi.fn(() => ({
    data: '/tmp/test-data',
    sessionData: '/tmp/test-session',
    logs: '/tmp/test-logs',
    temp: '/tmp/test-temp',
    cache: '/tmp/test-cache',
    root: '/tmp/test-root',
    profiles: '/tmp/test-profiles',
  })),
  preparePortablePaths: vi.fn(),
  getAppRoot: vi.fn(() => '/tmp/test-root'),
}))

let minimizeToTrayValue = false
let accountsConfig: AccountDefinition[] = []
let selectedAccountIdConfig: string | null = null

vi.mock('../../src/main/service-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/service-config.js')>()
  return {
    ...actual,
    loadServiceConfig: vi.fn(() => ({
      ok: true,
      createdDefaults: false,
      isReadOnly: false,
      config: {
        version: 2 as const,
        accounts: accountsConfig,
        selectedAccountId: selectedAccountIdConfig,
        preferences: {
          minimizeToTray: minimizeToTrayValue,
          notificationsEnabled: true,
          notificationHideContent: true,
        },
      },
    })),
    saveServiceConfig: vi.fn((portablePaths: unknown, config: unknown) => ({ ok: true, isReadOnly: false, config })),
  }
})

vi.mock('../../src/main/user-agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/user-agent.js')>()
  return {
    ...actual,
    getUserAgentSource: vi.fn(() => ({
      chrome: '120.0.0.0',
      full: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    })),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  iconConfig = { allEmpty: false, firstEmpty: false, constructorThrows: false }
  minimizeToTrayValue = false
  accountsConfig = []
  selectedAccountIdConfig = null
  createdTrays.length = 0
  trayConstructorCalls.length = 0
  createdImages.length = 0
  createdWindows.length = 0
  createdViews.length = 0
  baseWindowCounter = 0
  currentMenuTemplate = []
  mockApp._reset()
})

afterEach(() => {
  vi.resetModules()
})

async function loadEntrypoint (): Promise<{
  runtimeState: { trayController: TrayController | null; mainWindow: BaseWindow | null; shellView: WebContentsView | null; messengers: Map<string, unknown> }
}> {
  const mod = await import('../../src/main/index.ts')
  return mod as unknown as { runtimeState: { trayController: TrayController | null; mainWindow: BaseWindow | null; shellView: WebContentsView | null; messengers: Map<string, unknown> } }
}

function findMenuItem (label: string): { click: () => void } | undefined {
  const item = currentMenuTemplate.find((entry: unknown) => {
    const e = entry as { label?: string }
    return e.label === label
  }) as { click?: () => void } | undefined
  return item as { click: () => void } | undefined
}

function getWindow (): ReturnType<typeof makeFakeWindow> {
  expect(createdWindows.length).toBeGreaterThan(0)
  return createdWindows[0]
}

function getShellView (): ReturnType<typeof makeFakeWebContentsView> {
  expect(createdViews.length).toBeGreaterThan(0)
  return createdViews[0]
}

function getMessengerViews (): Array<ReturnType<typeof makeFakeWebContentsView>> {
  return createdViews.filter((v) => v.isMessenger)
}

// Wait for the async did-finish-load callback that triggers window.show().
function tick (): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

// Run multiple ticks so loadURL promises and did-finish-load settle.
async function settle (): Promise<void> {
  await tick()
  await tick()
}

describe('Tray entrypoint integration', () => {
  it('registers app handlers before controller exists and resolves getter later', async () => {
    const { runtimeState } = await loadEntrypoint()
    // Top-level registration happened synchronously before whenReady.
    expect(appHandlers['before-quit']).toHaveLength(1)
    expect(appHandlers['window-all-closed']).toHaveLength(1)
    expect(runtimeState.trayController).toBeNull()

    resolveWhenReady()
    await settle()

    expect(runtimeState.trayController).not.toBeNull()
  })

  it('before-quit -> close -> closed -> window-all-closed cleans up a messenger with minimizeToTray enabled', async () => {
    minimizeToTrayValue = true
    accountsConfig = [{
      accountId: '00000000-0000-0000-0000-000000000001',
      serviceId: 'whatsapp',
      displayName: 'Test',
      enabled: true,
    }]
    selectedAccountIdConfig = accountsConfig[0].accountId

    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const win = getWindow()
    const shellView = getShellView()
    const controller = runtimeState.trayController!
    const messengerViews = getMessengerViews()
    expect(messengerViews.length).toBe(1)
    expect(runtimeState.messengers.size).toBe(1)

    // Explicit quit path: before-quit marks quitting so the close guard does NOT hide.
    controller.isQuitting = false
    mockApp.emit('before-quit')
    expect(controller.isQuitting).toBe(true)

    win.close()
    expect(win.close).toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()

    // closed handler from app.ts destroyed the messenger and shell view.
    expect(messengerViews[0].webContents.close).toHaveBeenCalled()
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    expect(createdTrays[0]?.instance.destroy).toHaveBeenCalled()
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('native tray menu quit callback triggers real close/cleanup with minimizeToTray enabled', async () => {
    minimizeToTrayValue = true
    accountsConfig = [{
      accountId: '00000000-0000-0000-0000-000000000002',
      serviceId: 'telegram',
      displayName: 'Test',
      enabled: true,
    }]
    selectedAccountIdConfig = accountsConfig[0].accountId

    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const win = getWindow()
    const shellView = getShellView()
    const messengerViews = getMessengerViews()
    expect(messengerViews.length).toBe(1)
    const trayEntry = createdTrays[0]
    expect(trayEntry).toBeDefined()

    // Call the real "Beenden" menu callback from the tray context menu.
    const quitItem = findMenuItem('Beenden')
    expect(quitItem).toBeDefined()
    quitItem!.click()

    expect(runtimeState.trayController!.isQuitting).toBe(true)
    expect(win.close).toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()

    // No artificial second 'closed' event; win.close() already emitted it.
    expect(messengerViews[0].webContents.close).toHaveBeenCalled()
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    expect(trayEntry.instance.destroy).toHaveBeenCalled()
    expect(trayEntry.destroyed).toBe(true)
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('falls back to normal close when all tray icon candidates are empty and minimizeToTray is enabled', async () => {
    minimizeToTrayValue = true
    iconConfig.allEmpty = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    expect(runtimeState.trayController).not.toBeNull()
    expect(runtimeState.trayController!.tray).toBeNull()
    expect(createdImages.length).toBeGreaterThanOrEqual(3)
    expect(createdImages.every((img) => img.empty)).toBe(true)
    expect(trayConstructorCalls.length).toBe(0)

    const win = getWindow()
    const shellView = getShellView()
    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(win.hide).not.toHaveBeenCalled()
    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    // Guard did not intercept because no working tray exists.
    win.close()
    expect(win.isVisible()).toBe(false) // window was actually closed
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('uses empty first icon and falls back to a valid second icon passed to Tray constructor', async () => {
    minimizeToTrayValue = true
    iconConfig.firstEmpty = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    expect(runtimeState.trayController).not.toBeNull()
    expect(runtimeState.trayController!.tray).not.toBeNull()
    expect(createdImages.length).toBeGreaterThanOrEqual(2)
    expect(createdImages[0].path).toContain('icon.ico')
    expect(createdImages[0].empty).toBe(true)
    expect(createdImages[1].path).toContain('icon.png')
    expect(createdImages[1].empty).toBe(false)
    expect(trayConstructorCalls.length).toBe(1)
    expect(trayConstructorCalls[0].image.path).toContain('icon.png')
    expect(trayConstructorCalls[0].image.empty).toBe(false)

    const win = getWindow()
    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(win.hide).toHaveBeenCalled()
    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(win.isDestroyed()).toBe(false) // hidden, not closed
    expect(win.isVisible()).toBe(false) // hidden window is not visible
  })

  it('falls back to normal close when Tray constructor throws and minimizeToTray is enabled', async () => {
    minimizeToTrayValue = true
    iconConfig.constructorThrows = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    expect(runtimeState.trayController).not.toBeNull()
    expect(runtimeState.trayController!.tray).toBeNull()
    expect(trayConstructorCalls.length).toBe(1)

    const win = getWindow()
    const shellView = getShellView()
    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(win.hide).not.toHaveBeenCalled()
    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    win.close()
    expect(win.isVisible()).toBe(false)
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('falls back to normal close when tray is destroyed and recreation also fails, proving ensureTray', async () => {
    minimizeToTrayValue = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const controller = runtimeState.trayController!
    expect(controller.tray).not.toBeNull()
    controller.destroy()
    expect(createdTrays[0].destroyed).toBe(true)

    // Force future ensureTray to fail by emptying icons.
    iconConfig.allEmpty = true
    const imagesBefore = createdImages.length
    const traysBefore = trayConstructorCalls.length

    const win = getWindow()
    const shellView = getShellView()
    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(createdImages.length).toBeGreaterThan(imagesBefore)
    expect(createdTrays.length).toBe(1) // recreation could not construct a tray
    expect(trayConstructorCalls.length).toBe(traysBefore) // Tray constructor was not called again because icon was null
    expect(win.hide).not.toHaveBeenCalled()
    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    win.close()
    expect(win.isVisible()).toBe(false)
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('hides to tray when a working tray exists and minimizeToTray is enabled', async () => {
    minimizeToTrayValue = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const win = getWindow()
    expect(runtimeState.trayController).not.toBeNull()
    expect(runtimeState.trayController!.tray).not.toBeNull()

    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(win.hide).toHaveBeenCalled()
    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(win.isDestroyed()).toBe(false) // hidden, not closed
    expect(win.isVisible()).toBe(false) // hidden window is not visible

    // Views must NOT be cleaned up on hide-to-tray.
    expect(getShellView().webContents.close).not.toHaveBeenCalled()
    expect(runtimeState.mainWindow).not.toBeNull()
  })

  it('closes normally when minimizeToTray is disabled even with a working tray', async () => {
    minimizeToTrayValue = false
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const win = getWindow()
    const shellView = getShellView()
    const trayEntry = createdTrays[0]
    expect(runtimeState.trayController).not.toBeNull()
    expect(runtimeState.trayController!.tray).not.toBeNull()

    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(win.hide).not.toHaveBeenCalled()
    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    win.close()
    expect(win.isVisible()).toBe(false)
    expect(shellView.webContents.close).toHaveBeenCalled()
    expect(runtimeState.messengers.size).toBe(0)
    expect(runtimeState.mainWindow).toBeNull()
    expect(runtimeState.shellView).toBeNull()

    mockApp.emit('window-all-closed')
    if (trayEntry != null) {
      expect(trayEntry.instance.destroy).toHaveBeenCalled()
    }
    expect(runtimeState.trayController).toBeNull()
    expect(mockApp.quit).toHaveBeenCalled()
  })

  it('recreates a destroyed tray before hiding and hides to tray', async () => {
    minimizeToTrayValue = true
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const controller = runtimeState.trayController!
    controller.destroy()
    expect(createdTrays[0].destroyed).toBe(true)

    const imagesBefore = createdImages.length
    const traysBefore = trayConstructorCalls.length

    const win = getWindow()
    const closeEvent: FakeEvent = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('close', closeEvent)
    expect(createdImages.length).toBeGreaterThan(imagesBefore)
    expect(trayConstructorCalls.length).toBeGreaterThan(traysBefore)
    expect(createdTrays.length).toBe(2)
    expect(createdTrays[1].destroyed).toBe(false)
    expect(win.hide).toHaveBeenCalled()
    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(win.isDestroyed()).toBe(false) // hidden, not closed
    expect(win.isVisible()).toBe(false) // hidden window is not visible
  })

  it('second-instance handler restores and shows a hidden/minimized window', async () => {
    const { runtimeState } = await loadEntrypoint()
    resolveWhenReady()
    await settle()

    const win = getWindow()
    win.hide()
    ;(win.isMinimized as ReturnType<typeof vi.fn>).mockReturnValue(true)

    mockApp.emit('second-instance')
    expect(win.isMinimized).toHaveBeenCalled()
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(runtimeState.mainWindow).toBe(win)
  })
})
