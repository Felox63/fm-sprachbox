import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  attachShellGuards,
  attachRemoteGuards,
  isServiceUrl,
  isShellMainFrame,
  registerIpcHandlers,
  createAppWindow,
  createRuntime,
  type RuntimeState,
} from '../../src/main/app.js'

interface FakeEvent {
  preventDefault: () => void
  defaultPrevented: boolean
}

interface FakeWebContents {
  id: number
  url: string
  getURL: () => string
  setURL: (url: string) => void
  mainFrame: Electron.WebFrameMain
  on: (event: string, cb: (event: FakeEvent, ...args: unknown[]) => void) => void
  once: (event: string, cb: (event: FakeEvent, ...args: unknown[]) => void) => void
  setWindowOpenHandler: (handler: () => { action: string }) => void
  setUserAgent: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  listeners: Record<string, Array<(event: FakeEvent, ...args: unknown[]) => void>>
  onceListeners: Record<string, Array<(event: FakeEvent, ...args: unknown[]) => void>>
  windowOpenHandlers: Array<() => { action: string }>
  __webPreferences?: Record<string, unknown>
  emit: (event: string, ...args: unknown[]) => FakeEvent
  emitWillNavigate: (url: string) => FakeEvent
  emitWillRedirect: (url: string) => FakeEvent
  emitWillFrameNavigate: (url: string) => FakeEvent
}

let mockSessions: Map<string, { profileDir: string; cache: boolean; clearStorageData: ReturnType<typeof vi.fn>; setUserAgent: ReturnType<typeof vi.fn>; setPermissionRequestHandler: ReturnType<typeof vi.fn>; setPermissionCheckHandler: ReturnType<typeof vi.fn>; id: number }> = new Map()
let createdBaseWindows: Array<{
  contentView: { addChildView: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  getContentBounds: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
}> = []
let createdWebContentsViews: Array<{
  webContents: Electron.WebContents
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}> = []
let sessionIdCounter = 0

function makeFakeWebContents (overrides?: { url?: string }): FakeWebContents {
  const listeners: FakeWebContents['listeners'] = {}
  const onceListeners: FakeWebContents['onceListeners'] = {}
  const windowOpenHandlers: FakeWebContents['windowOpenHandlers'] = []
  let currentUrl = overrides?.url ?? ''

  const makeEvent = (eventName: string, args: unknown[]): FakeEvent & { isMainFrame?: boolean } => {
    if (eventName === 'will-frame-navigate' && args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      const existing = args[0] as { preventDefault?: () => void; defaultPrevented?: boolean; url?: string }
      if (typeof existing.preventDefault === 'function') {
        return existing as unknown as FakeEvent & { isMainFrame?: boolean }
      }
    }
    if (eventName === 'did-fail-load' && args.length > 0 && typeof args[0] === 'object' && args[0] !== null && 'isMainFrame' in (args[0] as object)) {
      const existing = args[0] as { isMainFrame?: boolean }
      const eventObj: FakeEvent & { isMainFrame?: boolean } = {
        preventDefault: () => { eventObj.defaultPrevented = true },
        defaultPrevented: false,
        isMainFrame: existing.isMainFrame,
      }
      return eventObj
    }
    const eventObj: FakeEvent & { isMainFrame?: boolean } = {
      preventDefault: () => { eventObj.defaultPrevented = true },
      defaultPrevented: false,
    }
    return eventObj
  }

  const wc: FakeWebContents = {
    id: Math.random(),
    url: currentUrl,
    getURL: () => currentUrl,
    setURL: (url: string) => { currentUrl = url },
    mainFrame: {
      parent: null,
      url: currentUrl,
    } as unknown as Electron.WebFrameMain,
    on: (event, cb) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event, cb) => {
      if (onceListeners[event] == null) onceListeners[event] = []
      onceListeners[event].push(cb)
    },
    setWindowOpenHandler: (handler) => {
      windowOpenHandlers.push(handler)
    },
    setUserAgent: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    listeners,
    onceListeners,
    windowOpenHandlers,
    emit: (event, ...args) => {
      // Electron's did-fail-load handler signature is
      // (event, errorCode, errorDescription, validatedURL, isMainFrame, isErrorPage).
      // When the caller passes a pre-built event object as the first argument,
      // use it and forward the remaining arguments.
      if (event === 'did-fail-load' && args.length > 0 && typeof args[0] === 'object' && args[0] !== null && 'isMainFrame' in (args[0] as object)) {
        const eventObj = args[0] as unknown as FakeEvent & { isMainFrame?: boolean }
        const cbs = listeners[event] ?? []
        for (const cb of cbs) {
          cb(eventObj, ...args.slice(1))
        }
        return eventObj
      }
      const eventObj = makeEvent(event, args)
      const cbs = listeners[event] ?? []
      for (const cb of cbs) {
        cb(eventObj, ...args)
      }
      return eventObj
    },
    emitWillNavigate: (url: string) => wc.emit('will-navigate', url),
    emitWillRedirect: (url: string) => wc.emit('will-redirect', url),
    emitWillFrameNavigate: (url: string) => {
      const eventObj = { url, preventDefault: () => { eventObj.defaultPrevented = true }, defaultPrevented: false } as unknown as FakeEvent
      return wc.emit('will-frame-navigate', eventObj)
    },
  }
  return wc
}

vi.mock('electron', async () => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}

  const mockApp = {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    setPath: vi.fn(),
    getVersion: vi.fn(() => '44.5.0'),
    getPath: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => { /* never resolves in unit tests */ })),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers[event] == null) handlers[event] = []
      handlers[event].push(handler)
    }),
    once: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      const list = handlers[event] ?? []
      for (const handler of list) {
        handler({}, ...args)
      }
    },
    _reset: () => {
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }
    },
  }

  const actual = await vi.importActual<typeof import('electron')>('electron')
  return {
    ...actual,
    app: mockApp,
    BaseWindow: vi.fn().mockImplementation(() => {
      const win = {
        contentView: { addChildView: vi.fn() },
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        getContentBounds: vi.fn(() => ({ width: 1280, height: 800 })),
        show: vi.fn(),
      }
      createdBaseWindows.push(win)
      return win
    }),
    WebContentsView: vi.fn().mockImplementation(({ webPreferences }: { webPreferences: Record<string, unknown> }) => {
      const wc = makeFakeWebContents()
      wc['__webPreferences'] = webPreferences
      const view = {
        webContents: wc as unknown as Electron.WebContents,
        setBounds: vi.fn(),
        setVisible: vi.fn(),
      }
      createdWebContentsViews.push(view)
      // Emit the real Electron event that the main entrypoint listens for.
      // This lets us verify the global popup-deny handler is registered before
      // any explicit per-view guards are attached.
      mockApp.emit('web-contents-created', wc)
      return view
    }),
    session: {
      fromPath: vi.fn((profileDir: string, opts?: { cache?: boolean }) => {
        if (!mockSessions.has(profileDir)) {
          sessionIdCounter += 1
          mockSessions.set(profileDir, {
            profileDir,
            cache: opts?.cache ?? false,
            clearStorageData: vi.fn(),
            setUserAgent: vi.fn(),
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            id: sessionIdCounter,
          })
        }
        return mockSessions.get(profileDir)
      }),
    },
    screen: {
      on: vi.fn(),
      off: vi.fn(),
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    shell: { openExternal: vi.fn() },
    ipcMain: {
      on: vi.fn(),
      handle: vi.fn(),
    },
  }
})

const electron = await import('electron')

beforeEach(() => {
  vi.clearAllMocks()
  mockSessions = new Map()
  createdBaseWindows = []
  createdWebContentsViews = []
  sessionIdCounter = 0
  ;(electron.app as unknown as { _reset: () => void })._reset()
})

function defaultConfig (): { version: 2; accounts: Array<{ accountId: string; serviceId: 'whatsapp' | 'telegram'; displayName: string; enabled: boolean }>; selectedAccountId: string | null; preferences: { minimizeToTray: boolean; notificationsEnabled: boolean; notificationHideContent: boolean } } {
  return {
    version: 2,
    accounts: [
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: '', enabled: true },
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: '', enabled: true },
    ],
    selectedAccountId: null,
    preferences: { minimizeToTray: false, notificationsEnabled: true, notificationHideContent: true },
  }
}

describe('attachShellGuards', () => {
  it('allows navigation to its own index.html', () => {
    const wc = makeFakeWebContents()
    attachShellGuards(wc as unknown as Electron.WebContents, '/out/renderer')
    const indexUrl = pathToFileURL(path.join('/out/renderer', 'index.html')).href
    const event = wc.emitWillFrameNavigate(indexUrl)
    expect(event.defaultPrevented).toBe(false)
  })

  it('blocks other files inside the renderer root', () => {
    const wc = makeFakeWebContents()
    attachShellGuards(wc as unknown as Electron.WebContents, '/out/renderer')
    const event = wc.emitWillFrameNavigate('file:///out/renderer/assets/main.js')
    expect(event.defaultPrevented).toBe(true)
  })

  it('blocks directory traversal', () => {
    const wc = makeFakeWebContents()
    attachShellGuards(wc as unknown as Electron.WebContents, '/out/renderer')
    const event = wc.emitWillFrameNavigate('file:///out/renderer/../main/index.js')
    expect(event.defaultPrevented).toBe(true)
  })

  it('blocks shell redirects to external URLs', () => {
    const wc = makeFakeWebContents()
    attachShellGuards(wc as unknown as Electron.WebContents, '/out/renderer')
    const event = wc.emitWillRedirect('https://example.com')
    expect(event.defaultPrevented).toBe(true)
  })

  it('denies new windows/popups from shell', () => {
    const wc = makeFakeWebContents()
    attachShellGuards(wc as unknown as Electron.WebContents, '/out/renderer')
    expect(wc.windowOpenHandlers).toHaveLength(1)
    expect(wc.windowOpenHandlers[0]()).toEqual({ action: 'deny' })
  })
})

describe('attachRemoteGuards', () => {
  it('allows navigation within the service origin', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    const event = wc.emitWillNavigate('https://web.whatsapp.com/chat')
    expect(event.defaultPrevented).toBe(false)
  })

  it('blocks navigation to unsupported origins', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    const event = wc.emitWillNavigate('https://example.com/cross')
    expect(event.defaultPrevented).toBe(true)
  })

  it('blocks remote redirects off-origin', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    const event = wc.emitWillRedirect('https://evil.example.com/')
    expect(event.defaultPrevented).toBe(true)
  })

  it('denies new windows from remote views', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    expect(wc.windowOpenHandlers).toHaveLength(1)
    expect(wc.windowOpenHandlers[0]({ url: 'https://evil.example.com/' })).toEqual({ action: 'deny' })
  })
})

describe('isServiceUrl', () => {
  it('allows supported service origins', () => {
    expect(isServiceUrl('https://web.whatsapp.com/')).toBe(true)
    expect(isServiceUrl('https://web.telegram.org/k/')).toBe(true)
  })

  it('blocks unsupported origins and protocols', () => {
    expect(isServiceUrl('https://example.com/')).toBe(false)
    expect(isServiceUrl('file:///etc/passwd')).toBe(false)
    expect(isServiceUrl('javascript:alert(1)')).toBe(false)
    expect(isServiceUrl('data:text/html,foo')).toBe(false)
  })
})

describe('isShellMainFrame', () => {
  const rendererRoot = '/out/renderer'
  const shellIndex = pathToFileURL(path.join(rendererRoot, 'index.html')).href

  function makeShellView (url: string): Electron.WebContentsView {
    const wc = makeFakeWebContents({ url })
    wc.mainFrame = { parent: null, url } as unknown as Electron.WebFrameMain
    return { webContents: wc as unknown as Electron.WebContents } as unknown as Electron.WebContentsView
  }

  it('accepts shell main frame with trusted index URL', () => {
    const shellView = makeShellView(shellIndex)
    const shellWc = shellView.webContents as unknown as FakeWebContents
    expect(isShellMainFrame(shellView, shellWc as unknown as Electron.WebContents, shellWc.mainFrame, rendererRoot)).toBe(true)
  })

  it('accepts index URL with fragment', () => {
    const shellView = makeShellView(`${shellIndex}#settings`)
    const shellWc = shellView.webContents as unknown as FakeWebContents
    expect(isShellMainFrame(shellView, shellWc as unknown as Electron.WebContents, shellWc.mainFrame, rendererRoot)).toBe(true)
  })

  it('rejects remote webContents', () => {
    const shellView = makeShellView(shellIndex)
    const remoteWc = makeFakeWebContents({ url: 'https://web.whatsapp.com/' })
    expect(isShellMainFrame(shellView, remoteWc as unknown as Electron.WebContents, remoteWc.mainFrame, rendererRoot)).toBe(false)
  })

  it('rejects non-main frame', () => {
    const shellView = makeShellView(shellIndex)
    const shellWc = shellView.webContents as unknown as FakeWebContents
    const subFrame = { parent: shellWc.mainFrame, url: shellIndex } as unknown as Electron.WebFrameMain
    expect(isShellMainFrame(shellView, shellWc as unknown as Electron.WebContents, subFrame, rendererRoot)).toBe(false)
  })

  it('rejects wrong frame URL using the same main frame identity', () => {
    const shellView = makeShellView(shellIndex)
    const shellWc = shellView.webContents as unknown as FakeWebContents
    // Same webContents and same frame object identity, but the frame reports a
    // different URL. This tests the URL check itself, not only frame identity.
    const frame = shellWc.mainFrame as unknown as { url: string }
    frame.url = 'file:///out/renderer/assets/main.js'
    expect(isShellMainFrame(shellView, shellWc as unknown as Electron.WebContents, shellWc.mainFrame, rendererRoot)).toBe(false)
  })

  it('rejects null shell view', () => {
    const wc = makeFakeWebContents({ url: shellIndex })
    expect(isShellMainFrame(null, wc as unknown as Electron.WebContents, wc.mainFrame, rendererRoot)).toBe(false)
  })
})

describe('registerIpcHandlers (account model)', () => {
  function makeShellView (url: string): Electron.WebContentsView {
    const wc = makeFakeWebContents({ url })
    wc.mainFrame = { parent: null, url } as unknown as Electron.WebFrameMain
    return { webContents: wc as unknown as Electron.WebContents } as unknown as Electron.WebContentsView
  }

  function depsFactory (_enabled: string[] = ['legacy-telegram']): Parameters<typeof registerIpcHandlers>[0] {
    const shellView = makeShellView(pathToFileURL(path.join('/out/renderer', 'index.html')).href)
    return {
      shellViewRef: { current: shellView },
      rendererRoot: '/out/renderer',
      activeAccountRef: { current: null },
      messengers: new Map(),
      portablePaths: {
        appRoot: '/app',
        data: '/app/data',
        configFile: '/app/data/services.json',
        logs: '/app/data/logs',
        profiles: '/app/data/profiles',
        temp: '/app/data/tmp',
        cache: '/app/data/cache',
        sessionData: '/app/data/session-data',
      },
      serviceConfigRef: { current: defaultConfig() },
      sendAccountList: vi.fn(),
      showAccount: vi.fn(),
      showHome: vi.fn(),
      setAccountEnabled: vi.fn(),
      addAccount: vi.fn(),
      renameAccount: vi.fn(),
      persistConfigPreference: vi.fn(),
    }
  }

  it('registers expected IPC handlers', () => {
    registerIpcHandlers(depsFactory())
    const channels = electron.ipcMain.on.mock.calls.map((call) => call[0] as string)
    expect(channels).toContain('select-account')
    expect(channels).toContain('go-home')
    expect(channels).toContain('set-account-enabled')
    expect(channels).toContain('add-account')
    expect(channels).toContain('rename-account')
    expect(channels).toContain('get-portable-paths')
  })

  it('accepts select-account from shell main frame and calls showAccount', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'select-account')?.[1] as
      | ((event: unknown, accountId: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram')
    expect(deps.showAccount).toHaveBeenCalledWith('legacy-telegram')
  })

  it('rejects select-account for disabled account', () => {
    const deps = depsFactory(['legacy-whatsapp'])
    // Disable telegram in the config so the test actually exercises the disabled check.
    deps.serviceConfigRef.current = {
      ...deps.serviceConfigRef.current,
      accounts: deps.serviceConfigRef.current.accounts.map((a) =>
        a.accountId === 'legacy-telegram' ? { ...a, enabled: false } : a,
      ),
    }
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'select-account')?.[1] as
      | ((event: unknown, accountId: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram')
    expect(deps.showAccount).not.toHaveBeenCalled()
  })

  it('rejects select-account from remote webContents', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'select-account')?.[1] as
      | ((event: unknown, accountId: string) => void)
    const remoteWc = makeFakeWebContents({ url: 'https://web.whatsapp.com/' })
    handler?.({ sender: remoteWc as unknown as Electron.WebContents, senderFrame: remoteWc.mainFrame }, 'legacy-telegram')
    expect(deps.showAccount).not.toHaveBeenCalled()
  })

  it('routes set-account-enabled to handler from shell main frame', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'set-account-enabled')?.[1] as
      | ((event: unknown, accountId: string, enabled: boolean) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram', false)
    expect(deps.setAccountEnabled).toHaveBeenCalledWith('legacy-telegram', false)
  })

  it('rejects invalid account ids in set-account-enabled', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'set-account-enabled')?.[1] as
      | ((event: unknown, accountId: unknown, enabled: unknown) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    const cases: unknown[] = ['not-a-uuid', 'path/traversal', '../../etc', 123, null]
    for (const bad of cases) {
      handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, bad, false)
    }
    expect(deps.setAccountEnabled).not.toHaveBeenCalled()
  })

  it('routes add-account for known service from shell main frame', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'add-account')?.[1] as
      | ((event: unknown, serviceId: string, name?: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'telegram', 'Zweitaccount')
    expect(deps.addAccount).toHaveBeenCalledWith('telegram', 'Zweitaccount')
  })

  it('rejects add-account for unknown service', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'add-account')?.[1] as
      | ((event: unknown, serviceId: unknown, name?: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'signal', '')
    expect(deps.addAccount).not.toHaveBeenCalled()
  })

  it('routes rename-account from shell main frame with sanitized name', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'rename-account')?.[1] as
      | ((event: unknown, accountId: string, name: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram', 'Felix')
    expect(deps.renameAccount).toHaveBeenCalledWith('legacy-telegram', 'Felix')
  })

  it('does not leak payload contents in warnings for invalid IPC', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'add-account')?.[1] as
      | ((event: unknown, serviceId: unknown, name?: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'https://evil.example.com', '')
    expect(deps.addAccount).not.toHaveBeenCalled()
    const warnings = spy.mock.calls.map((call) => String(call[0]))
    expect(warnings.some((w) => w.includes('https://evil.example.com'))).toBe(false)
    spy.mockRestore()
  })

  it('returns portable paths for trusted sender', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'get-portable-paths')?.[1] as
      | ((event: Record<string, unknown>) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    const event: Record<string, unknown> = { sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame, returnValue: undefined }
    handler?.(event)
    expect(event.returnValue).toEqual(deps.portablePaths)
  })

  it('returns error returnValue for untrusted sender', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'get-portable-paths')?.[1] as
      | ((event: Record<string, unknown>) => void)
    const remoteWc = makeFakeWebContents({ url: 'https://web.whatsapp.com/' })
    const event: Record<string, unknown> = { sender: remoteWc as unknown as Electron.WebContents, senderFrame: remoteWc.mainFrame, returnValue: undefined }
    handler?.(event)
    expect(event.returnValue).toEqual({ error: 'untrusted sender' })
  })
})

describe('createAppWindow', () => {
  it('creates BaseWindow and shell view with secure webPreferences', () => {
    const result = createAppWindow({
      app: { isPackaged: false } as unknown as Electron.App,
      rendererRoot: '/out/renderer',
      portablePaths: {
        appRoot: '/app',
        data: '/app/data',
        configFile: '/app/data/services.json',
        logs: '/app/data/logs',
        profiles: '/app/data/profiles',
        temp: '/app/data/tmp',
        cache: '/app/data/cache',
        sessionData: '/app/data/session-data',
      },
      preloadPath: '/out/preload/preload.cjs',
    })
    expect(result.window).toBeDefined()
    expect(result.shellView).toBeDefined()
    const shellWc = result.shellView.webContents as unknown as FakeWebContents
    expect(shellWc['__webPreferences']?.sandbox).toBe(true)
    expect(shellWc['__webPreferences']?.nodeIntegration).toBe(false)
    expect(shellWc['__webPreferences']?.contextIsolation).toBe(true)
    expect(shellWc['__webPreferences']?.preload).toBe('/out/preload/preload.cjs')
    expect(shellWc.listeners['will-frame-navigate']).toHaveLength(1)
    expect(shellWc.listeners['will-redirect']).toHaveLength(1)
    expect(shellWc.windowOpenHandlers).toHaveLength(1)
  })
})

function makeRuntime (overrides?: { portablePaths?: Parameters<typeof createRuntime>[0]['portablePaths'] }): {
  runtime: ReturnType<typeof createRuntime>
  state: RuntimeState
  portablePaths: Parameters<typeof createRuntime>[0]['portablePaths']
} {
  const state: RuntimeState = {
    mainWindow: null,
    shellView: null,
    messengers: new Map(),
    activeAccountId: null,
    showingHome: false,
    serviceConfig: defaultConfig(),
    lastConfigSaveError: 'none',
    trayController: null,
  }
  const portablePaths = overrides?.portablePaths ?? {
    appRoot: '/app',
    data: '/app/data',
    configFile: '/app/data/services.json',
    logs: '/app/data/logs',
    profiles: '/app/data/profiles',
    temp: '/app/data/tmp',
    cache: '/app/data/cache',
    sessionData: '/app/data/session-data',
  }
  const runtime = createRuntime({
    app: { isPackaged: false } as unknown as Electron.App,
    state,
    rendererRoot: '/out/renderer',
    portablePaths,
    preloadPath: '/out/preload/preload.cjs',
    userAgentSource: { chrome: '126.0.0.0', electron: '44.5.0' },
  })
  return { runtime, state, portablePaths }
}

describe('createRuntime integration (accounts)', () => {
  it('removes only the confirmed account entry and preserves profile files', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'remove-account-'))
    try {
      const { portablePaths: template } = makeRuntime()
      const portablePaths = { ...template, configFile: path.join(dir, 'services.json'), profiles: path.join(dir, 'profiles') }
      const { runtime, state } = makeRuntime({ portablePaths })
      const marker = path.join(portablePaths.profiles, 'telegram', 'login-marker')
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(marker, 'preserve')
      runtime.createWindow()
      runtime.registerIpc()
      const wc = state.shellView!.webContents as unknown as FakeWebContents
      wc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const handler = vi.mocked(electron.ipcMain.handle).mock.calls.find(c => c[0] === 'remove-account')![1]
      const event = { sender: wc, senderFrame: wc.mainFrame } as unknown as Electron.IpcMainInvokeEvent
      expect(await handler(event, 'legacy-telegram')).toBe(false)
      expect(state.serviceConfig.accounts).toHaveLength(2)
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      expect(await handler(event, 'legacy-telegram')).toBe(true)
      expect(state.serviceConfig.accounts.some(a => a.accountId === 'legacy-telegram')).toBe(false)
      expect(JSON.parse(fs.readFileSync(portablePaths.configFile, 'utf8')).accounts).toHaveLength(1)
      expect(fs.readFileSync(marker, 'utf8')).toBe('preserve')
      expect(await handler({ ...event, sender: {} } as Electron.IpcMainInvokeEvent, 'legacy-whatsapp')).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  function getLastFakeWebContents (): FakeWebContents {
    const view = createdWebContentsViews[createdWebContentsViews.length - 1]
    return view.webContents as unknown as FakeWebContents
  }

  function getShellFakeWebContents (state: RuntimeState): FakeWebContents {
    return state.shellView!.webContents as unknown as FakeWebContents
  }

  function triggerClosed (state: RuntimeState): void {
    const win = state.mainWindow as unknown as ReturnType<typeof electron.BaseWindow>
    const closedHandler = win.on.mock.calls.find((call) => call[0] === 'closed')?.[1] as (() => void) | undefined
    closedHandler?.()
  }

  it('creates a window with shell view and preloads the account list', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()

    expect(state.mainWindow).not.toBeNull()
    expect(state.shellView).not.toBeNull()
    expect(createdBaseWindows).toHaveLength(1)

    const shellWc = getShellFakeWebContents(state)
    expect(shellWc.loadFile).toHaveBeenCalledWith(path.join('/out/renderer', 'index.html'))

    const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    expect(shellWc.send).toHaveBeenCalledWith('accounts', expect.any(Object))
    expect(state.showingHome).toBe(true)
    expect(state.activeAccountId).toBeNull()
  })

  it('creates isolated sessions for each account and keeps them separate', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    runtime.showAccount('legacy-telegram')

    expect(state.messengers.size).toBe(2)
    const whatsappProfile = path.join('/app/data/profiles', 'whatsapp')
    const telegramProfile = path.join('/app/data/profiles', 'telegram')
    expect(mockSessions.has(whatsappProfile)).toBe(true)
    expect(mockSessions.has(telegramProfile)).toBe(true)
    expect(whatsappProfile).not.toEqual(telegramProfile)
  })

  it('creates distinct sessions for two telegram accounts', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    const secondTelegramId = '12345678-1234-1234-1234-1234567890ab'
    state.serviceConfig.accounts.push({
      accountId: secondTelegramId,
      serviceId: 'telegram',
      displayName: 'Privat',
      enabled: true,
    })

    runtime.showAccount('legacy-telegram')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    runtime.showAccount(secondTelegramId)
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const legacyProfile = path.join('/app/data/profiles', 'telegram')
    const newProfile = path.join('/app/data/profiles', 'accounts', secondTelegramId)
    expect(mockSessions.has(legacyProfile)).toBe(true)
    expect(mockSessions.has(newProfile)).toBe(true)
    expect(legacyProfile).not.toEqual(newProfile)
  })

  it('reuses existing messenger view and does not reload same URL', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    const whatsappWc = getLastFakeWebContents()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    whatsappWc.setURL('https://web.whatsapp.com')
    const loadCount = whatsappWc.loadURL.mock.calls.length

    runtime.showAccount('legacy-telegram')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    runtime.showAccount('legacy-whatsapp')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(state.messengers.size).toBe(2)
    expect(whatsappWc.loadURL.mock.calls.length).toBe(loadCount)
  })

  it('preserves view and path when renaming an account', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-telegram')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const telegramEntry = state.messengers.get('legacy-telegram')!
    const originalPath = telegramEntry.messenger.view.webContents['__webPreferences']?.session?.profileDir
    const originalView = telegramEntry.messenger.view

    // Rename only changes displayName in config; the runtime does not recreate the view.
    state.serviceConfig = {
      ...state.serviceConfig,
      accounts: state.serviceConfig.accounts.map((a) =>
        a.accountId === 'legacy-telegram' ? { ...a, displayName: 'Privat' } : a,
      ),
    }

    runtime.showAccount('legacy-telegram')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(state.messengers.get('legacy-telegram')?.messenger.view).toBe(originalView)
    const currentPath = state.messengers.get('legacy-telegram')?.messenger.view.webContents['__webPreferences']?.session?.profileDir
    expect(currentPath).toBe(originalPath)
  })

  it('deactivating active account returns to home and keeps view', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(state.activeAccountId).toBe('legacy-whatsapp')

    // Simulate disabling the active account through IPC path by directly mutating config.
    state.serviceConfig = {
      ...state.serviceConfig,
      accounts: state.serviceConfig.accounts.map((a) =>
        a.accountId === 'legacy-whatsapp' ? { ...a, enabled: false } : a,
      ),
    }
    runtime.showHome()
    expect(state.activeAccountId).toBeNull()
    expect(state.showingHome).toBe(true)
    // View is kept (not destroyed).
    expect(state.messengers.has('legacy-whatsapp')).toBe(true)
  })

  it('closes shell and all messenger webContents on window closed', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    runtime.showAccount('legacy-telegram')

    const shellWc = getShellFakeWebContents(state)
    const messengerWcs = Array.from(state.messengers.values()).map((m) => m.messenger.view.webContents as unknown as FakeWebContents)
    expect(messengerWcs).toHaveLength(2)

    triggerClosed(state)

    expect(shellWc.close).toHaveBeenCalled()
    for (const wc of messengerWcs) {
      expect(wc.close).toHaveBeenCalled()
    }
    expect(state.messengers.size).toBe(0)
    expect(state.shellView).toBeNull()
    expect(state.mainWindow).toBeNull()
  })

  it('assigns distinct sessions and secure webPreferences to each remote view', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    runtime.showAccount('legacy-telegram')

    expect(state.messengers.size).toBe(2)
    const whatsappView = state.messengers.get('legacy-whatsapp')!
    const telegramView = state.messengers.get('legacy-telegram')!

    expect(whatsappView.messenger.session).not.toBe(telegramView.messenger.session)
    const whatsappWc = whatsappView.messenger.view.webContents as unknown as FakeWebContents
    const telegramWc = telegramView.messenger.view.webContents as unknown as FakeWebContents

    // The actual session object must be the one passed to the WebContentsView
    // webPreferences; otherwise a shared/fallback session could be used.
    expect(whatsappWc['__webPreferences']?.session).toBe(whatsappView.messenger.session)
    expect(telegramWc['__webPreferences']?.session).toBe(telegramView.messenger.session)
    expect(whatsappWc['__webPreferences']?.session).not.toBe(telegramWc['__webPreferences']?.session)

    for (const wc of [whatsappWc, telegramWc]) {
      expect(wc['__webPreferences']?.nodeIntegration).toBe(false)
      expect(wc['__webPreferences']?.contextIsolation).toBe(true)
      expect(wc['__webPreferences']?.sandbox).toBe(true)
      expect(wc['__webPreferences']?.webSecurity).toBe(true)
      expect(wc['__webPreferences']?.preload).toContain('messenger-preload.cjs')
    }
  })

  it('lays out shell full-window in home mode and sidebar+messenger in account mode', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const win = state.mainWindow as unknown as ReturnType<typeof electron.BaseWindow>
    const shellView = state.shellView as unknown as { setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> }
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    // After createWindow + showHome, shell should fill the window before show().
    expect(shellView.setBounds).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 0, width: 1280, height: 800 }))

    runtime.showAccount('legacy-whatsapp')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const whatsappBounds = (state.messengers.get('legacy-whatsapp')!.messenger.view as unknown as { setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> }).setBounds
    const lastWhatsAppBounds = whatsappBounds.mock.calls[whatsappBounds.mock.calls.length - 1][0]
    expect(lastWhatsAppBounds.x).toBe(220)
    expect(lastWhatsAppBounds.width).toBe(1060)
    expect(lastWhatsAppBounds.height).toBe(800)

    runtime.showHome()
    expect(shellView.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0, width: 1280, height: 800 }))

    // Simulate a resize event.
    win.getContentBounds.mockReturnValue({ width: 1000, height: 700 })
    const resizeHandler = win.on.mock.calls.find((call) => call[0] === 'resize')?.[1] as (() => void) | undefined
    resizeHandler?.()
    expect(shellView.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0, width: 1000, height: 700 }))
  })

  it('expands shell to full window and hides remote view while loading or on error', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const shellView = state.shellView as unknown as { setBounds: ReturnType<typeof vi.fn> }
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    // Immediately after showAccount the view is loading -> overlay mode.
    expect(shellView.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0, width: 1280, height: 800 }))
    const whatsappView = state.messengers.get('legacy-whatsapp')!.messenger.view as unknown as { setVisible: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn> }
    expect(whatsappView.setVisible).toHaveBeenLastCalledWith(false)

    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // After loadURL resolves, overlay mode ends and sidebar+messenger layout returns.
    const lastAfterLoad = shellView.setBounds.mock.calls[shellView.setBounds.mock.calls.length - 1][0]
    expect(lastAfterLoad.width).toBe(220)
    expect(whatsappView.setVisible).toHaveBeenLastCalledWith(true)

    const whatsappWc = getLastFakeWebContents()
    whatsappWc.emit('did-fail-load', { isMainFrame: true }, -105, 'network error', 'https://web.whatsapp.com/', true, 1, 1)
    // Error overlay expands shell again and hides the remote view.
    const lastAfterError = shellView.setBounds.mock.calls[shellView.setBounds.mock.calls.length - 1][0]
    expect(lastAfterError.width).toBe(1280)
    expect(whatsappView.setVisible).toHaveBeenLastCalledWith(false)

    // Retry restores sidebar+messenger layout.
    runtime.showAccount('legacy-whatsapp')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const lastAfterRetry = shellView.setBounds.mock.calls[shellView.setBounds.mock.calls.length - 1][0]
    expect(lastAfterRetry.width).toBe(220)
    expect(whatsappView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('propagates config save errors to the renderer', async () => {
    const tempRoot = path.join(os.tmpdir(), `sprachbox-config-error-${Date.now()}`)
    fs.mkdirSync(tempRoot, { recursive: true })
    const dataDir = path.join(tempRoot, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const blockingFile = path.join(dataDir, 'blocking-file')
    fs.writeFileSync(blockingFile, 'I block the dir', 'utf8')
    const badPaths: Parameters<typeof createRuntime>[0]['portablePaths'] = {
      appRoot: tempRoot,
      data: dataDir,
      configFile: path.join(blockingFile, 'services.json'),
      logs: path.join(dataDir, 'logs'),
      profiles: path.join(dataDir, 'profiles'),
      temp: path.join(dataDir, 'tmp'),
      cache: path.join(dataDir, 'cache'),
      sessionData: path.join(dataDir, 'session-data'),
    }

    const { runtime, state } = makeRuntime({ portablePaths: badPaths })
    runtime.createWindow()
    runtime.registerIpc()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    const shellWc = getShellFakeWebContents(state)
    const shellIndex = pathToFileURL(path.join('/out/renderer', 'index.html')).href
    ;(shellWc.mainFrame as unknown as { url: string }).url = shellIndex
    shellWc.send.mockClear()

    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'set-account-enabled')?.[1] as
      | ((event: unknown, accountId: unknown, enabled: unknown) => void)
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram', false)

    const configCall = shellWc.send.mock.calls.find((call) => call[0] === 'accounts')
    expect(configCall).toBeDefined()
    expect(configCall[1].saveError).toBe('save-write-failed')
  })

  it('sets fail-closed permission handlers on each isolated session', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    runtime.showAccount('legacy-telegram')

    expect(state.messengers.size).toBe(2)
    for (const entry of state.messengers.values()) {
      const session = entry.messenger.session as unknown as { setPermissionRequestHandler: ReturnType<typeof vi.fn>; setPermissionCheckHandler: ReturnType<typeof vi.fn> }
      expect(session.setPermissionRequestHandler).toHaveBeenCalled()
      expect(session.setPermissionCheckHandler).toHaveBeenCalled()
    }
  })

  it('does not reload a remote view while a load is already pending', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    const whatsappWc = getLastFakeWebContents()
    // Make loadURL return a never-resolving promise to keep pendingLoad true.
    whatsappWc.loadURL.mockImplementation(() => new Promise(() => { /* never resolves */ }))
    // Trigger a retry while pendingLoad is true.
    runtime.showAccount('legacy-whatsapp')
    expect(whatsappWc.loadURL.mock.calls.length).toBe(1)
  })

  it('ignores stale loadURL resolutions after a newer load started', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    const whatsappWc = getLastFakeWebContents()
    let firstResolve: (() => void) | null = null
    whatsappWc.loadURL.mockImplementation(() => new Promise((resolve) => { firstResolve = resolve }))
    runtime.showAccount('legacy-whatsapp')

    // Simulate a new load starting while the first is still pending by recreating
    // the pending state through a forced retry. In the runtime this is guarded,
    // so the easiest way is to bump generation by emitting a terminal failure.
    whatsappWc.emit('did-fail-load', { isMainFrame: true }, -105, 'network error', 'https://web.whatsapp.com/', true, 1, 1)

    // Now resolve the original stale promise.
    firstResolve?.()
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // The stale resolution must not overwrite the failed state.
    const entry = state.messengers.get('legacy-whatsapp')!
    expect(entry.loadState.failed).toBe(true)
  })
})

describe('real main entrypoint', () => {
  const tempRoot = path.join(os.tmpdir(), `sprachbox-entrypoint-${Date.now()}`)

  beforeEach(() => {
    vi.resetModules()
    fs.mkdirSync(tempRoot, { recursive: true })
    process.env.PORTABLE_APP_ROOT = tempRoot
  })

  afterEach(() => {
    delete process.env.PORTABLE_APP_ROOT
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('registers a global popup-deny handler before per-view guards are attached', async () => {
    await import('../../src/main/index.ts')

    // Simulate the Konstruktor-Event that Electron emits during new WebContentsView().
    // The global handler from index.ts must already be registered at this point.
    const wc = makeFakeWebContents()
    electron.app.emit('web-contents-created', wc)
    expect(wc.windowOpenHandlers).toHaveLength(1)
    expect(wc.windowOpenHandlers[0]()).toEqual({ action: 'deny' })
  })

  it('applies global popup-deny to shell view created through the runtime path', async () => {
    vi.doMock('../../src/main/user-agent.js', () => ({
      getUserAgentSource: vi.fn(() => ({ chrome: '126.0.0.0', electron: '44.5.0' })),
    }))
    await import('../../src/main/index.ts')

    // Build a runtime as createRuntime() in app.ts does, which internally uses
    // createAppWindow and therefore emits the web-contents-created event.
    const state: RuntimeState = {
      mainWindow: null,
      shellView: null,
      messengers: new Map(),
      activeAccountId: null,
      showingHome: false,
      serviceConfig: defaultConfig(),
      lastConfigSaveError: 'none',
      trayController: null,
    }
    const runtime = createRuntime({
      app: electron.app as unknown as Electron.App,
      state,
      rendererRoot: '/out/renderer',
      portablePaths: {
        appRoot: tempRoot,
        data: path.join(tempRoot, 'data'),
        configFile: path.join(tempRoot, 'data', 'services.json'),
        logs: path.join(tempRoot, 'data', 'logs'),
        profiles: path.join(tempRoot, 'data', 'profiles'),
        temp: path.join(tempRoot, 'data', 'tmp'),
        cache: path.join(tempRoot, 'data', 'cache'),
        sessionData: path.join(tempRoot, 'data', 'session-data'),
      },
      preloadPath: '/out/preload/preload.cjs',
      userAgentSource: { chrome: '126.0.0.0', electron: '44.5.0' },
    })

    runtime.createWindow()
    expect(state.shellView).not.toBeNull()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents

    // The global handler + shell guards are both attached.
    expect(shellWc.windowOpenHandlers.length).toBeGreaterThanOrEqual(1)
    expect(shellWc.windowOpenHandlers[shellWc.windowOpenHandlers.length - 1]()).toEqual({ action: 'deny' })

    const indexUrl = pathToFileURL(path.join('/out/renderer', 'index.html')).href
    expect(shellWc.emitWillFrameNavigate(indexUrl).defaultPrevented).toBe(false)
    expect(shellWc.emitWillFrameNavigate('file:///out/renderer/assets/main.js').defaultPrevented).toBe(true)
  })
})
