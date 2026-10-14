import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import vm from 'node:vm'
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
import { createMessengerView } from '../../src/main/messenger-view.js'
import { FM_NOTIFICATION_BRIDGE } from '../../src/main/notifications.js'
import { loadServiceConfig } from '../../src/main/service-config.js'

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
  destroyed: boolean
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
  isDestroyed?: () => boolean
  destroy?: () => void
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
    setURL: (url: string) => {
      currentUrl = url
      const frame = (wc.mainFrame as unknown as { url: string })
      if (frame != null) frame.url = url
    },
    mainFrame: {
      parent: null,
      url: currentUrl,
    } as unknown as Electron.WebFrameMain,
    destroyed: false,
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
    isDestroyed: () => wc.destroyed,
    destroy: () => { wc.destroyed = true },
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
      if (event === 'ipc-message') Object.assign(eventObj, { sender: wc, senderFrame: wc.mainFrame })
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
    Notification: vi.fn().mockImplementation(() => ({ show: vi.fn(), on: vi.fn() })),
    BaseWindow: vi.fn().mockImplementation(() => {
      const win = {
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        getContentBounds: vi.fn(() => ({ width: 1280, height: 800 })),
        show: vi.fn(),
        focus: vi.fn(),
        restore: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isVisible: vi.fn(() => true),
        isMinimized: vi.fn(() => false),
        isFocused: vi.fn(() => true),
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
    Menu: { buildFromTemplate: vi.fn((template) => ({ popup: vi.fn(), template })),
    },
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
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

  it('blocks subframe navigation off-origin', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    const event = wc.emitWillFrameNavigate('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE')
    expect(event.defaultPrevented).toBe(true)
  })

  it('denies new windows from remote views', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    expect(wc.windowOpenHandlers).toHaveLength(1)
    expect(wc.windowOpenHandlers[0]({ url: 'https://evil.example.com/' })).toEqual({ action: 'deny' })
  })

  it('does not open browser for off-origin top-level navigation', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    wc.emitWillNavigate('https://example.com/cross')
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not open browser for off-origin redirects', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    wc.emitWillRedirect('https://evil.example.com/')
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not open browser for off-origin subframe navigation', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    wc.emitWillFrameNavigate('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE')
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('registers only one redirect handler', () => {
    const wc = makeFakeWebContents()
    attachRemoteGuards(wc as unknown as Electron.WebContents)
    expect(wc.listeners['will-redirect']).toHaveLength(1)
  })
})

function pathsForMessengerTests (root: string): Parameters<typeof createMessengerView>[1] {
  return {
    appRoot: root,
    data: path.join(root, 'data'),
    configFile: path.join(root, 'data', 'services.json'),
    logs: path.join(root, 'data', 'logs'),
    profiles: path.join(root, 'data', 'profiles'),
    temp: path.join(root, 'data', 'tmp'),
    cache: path.join(root, 'data', 'cache'),
    sessionData: path.join(root, 'data', 'session-data'),
  }
}

function makeAccount (serviceId: 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'whatsapp-business'): Parameters<typeof createMessengerView>[0] {
  const legacyId = serviceId === 'whatsapp' ? 'legacy-whatsapp'
    : serviceId === 'telegram' ? 'legacy-telegram'
      : undefined
  return {
    accountId: legacyId ?? '12345678-1234-1234-1234-1234567890ab',
    serviceId,
    displayName: 'Test',
    enabled: true,
  }
}

describe('createMessengerView navigation guards', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'messenger-view-'))
    vi.mocked(electron.shell.openExternal).mockClear()
  })

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('blocks WhatsApp internal subframe URLs without opening browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const event1 = wc.emitWillFrameNavigate('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE')
    expect(event1.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()

    const event2 = wc.emitWillFrameNavigate('https://flows.whatsapp.net/flows/cache_management/')
    expect(event2.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('blocks remote redirects for WhatsApp internal URLs and does not open browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const event1 = wc.emitWillRedirect('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE')
    expect(event1.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()

    const event2 = wc.emitWillRedirect('https://flows.whatsapp.net/flows/cache_management/')
    expect(event2.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('blocks remote top-level navigation for WhatsApp internal URLs without opening browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const event = wc.emitWillNavigate('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE')
    expect(event.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })
  it('blocks other foreign HTTP/HTTPS subframes and redirects without opening browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const frameEventHttps = wc.emitWillFrameNavigate('https://evil.example.com/frame')
    expect(frameEventHttps.defaultPrevented).toBe(true)

    const frameEventHttp = wc.emitWillFrameNavigate('http://evil.example.com/frame')
    expect(frameEventHttp.defaultPrevented).toBe(true)

    const redirectEventHttps = wc.emitWillRedirect('https://web.telegram.org/k/')
    expect(redirectEventHttps.defaultPrevented).toBe(true)

    const redirectEventHttp = wc.emitWillRedirect('http://evil.example.com/redirect')
    expect(redirectEventHttp.defaultPrevented).toBe(true)

    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('blocks programmatic top-level navigation without opening browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const event = wc.emitWillNavigate('https://example.com/article')
    expect(event.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not open a browser even if setWindowOpenHandler and will-navigate fire for the same URL', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents

    const popupResult = wc.windowOpenHandlers[0]({ url: 'https://example.com/article' })
    expect(popupResult).toEqual({ action: 'deny' })
    const navEvent = wc.emitWillNavigate('https://example.com/article')
    expect(navEvent.defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('denies all popup requests via setWindowOpenHandler without opening browser', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    expect(wc.windowOpenHandlers).toHaveLength(1)

    const result = wc.windowOpenHandlers[0]({ url: 'https://example.com/article' })
    expect(result).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('never opens unsafe URLs via setWindowOpenHandler', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    const unsafeUrls = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,foo',
      'custom-app://open',
      'mailto:md@merkeldesign.biz',
      'https://user:pass@example.com/',
    ]

    for (const url of unsafeUrls) {
      const result = wc.windowOpenHandlers[0]({ url })
      expect(result).toEqual({ action: 'deny' })
    }
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('applies createMessengerView guards plus attachRemoteGuards without overriding service-origin policy', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    // This is what createRuntime.registerRemoteView does in the real app.
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    // Service-origin navigation stays allowed.
    expect(wc.emitWillNavigate('https://web.whatsapp.com/chat').defaultPrevented).toBe(false)

    // Off-origin top-level navigation is blocked.
    expect(wc.emitWillNavigate('https://example.com/article').defaultPrevented).toBe(true)

    // Both exakt WhatsApp internal URLs as subframes and redirects are blocked without opening browser.
    expect(wc.emitWillFrameNavigate('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://flows.whatsapp.net/flows/cache_management/').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://flows.whatsapp.net/flows/cache_management/').defaultPrevented).toBe(true)

    // Foreign HTTP/HTTPS subframes and redirects are also blocked.
    expect(wc.emitWillFrameNavigate('http://evil.example.com/frame').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://evil.example.com/frame').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('http://evil.example.com/redirect').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://web.telegram.org/k/').defaultPrevented).toBe(true)

    expect(electron.shell.openExternal).not.toHaveBeenCalled()

    // Electron replaces the previous setWindowOpenHandler; the last registered
    // handler wins. Both handlers deny, so the effective behaviour is still deny.
    expect(wc.windowOpenHandlers).toHaveLength(2)
    expect(wc.windowOpenHandlers[1]({ url: 'https://example.com/article' })).toEqual({ action: 'deny' })

    // Service-origin popup is also denied by the effective (last) handler.
    expect(wc.windowOpenHandlers[1]({ url: 'https://web.whatsapp.com/chat' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('registers a context-menu listener for trusted external link actions', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    expect(wc.listeners['context-menu']).toHaveLength(1)
  })

  it('context-menu path opens only safe external links after explicit user action', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    // Apply the same runtime guard pairing that the real app uses.
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    const event = wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(event.defaultPrevented).toBe(true)
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalled()
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    vi.mocked(electron.shell.openExternal).mockResolvedValueOnce(undefined)
    await (template[0].click as () => void | Promise<void>)()
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('context-menu path rejects after view destruction even with remote guards attached', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    wc.destroy()
    await (template[0].click as () => void | Promise<void>)()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path rejects live frame URL that no longer matches service origin', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    wc.setURL('https://user:pass@web.whatsapp.com/')
    await (template[0].click as () => void | Promise<void>)()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path rejects oversized payload when menu is clicked', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    const longUrl = `https://example.com/?x=${'a'.repeat(4080)}`
    const event = wc.emit('context-menu', {
      linkURL: longUrl,
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    // Long URL is rejected already at menu build time; no menu is created.
    expect(event.defaultPrevented).toBe(false)
    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path rejects openExternal rejection without leaking URL in any log argument', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })
    vi.mocked(electron.shell.openExternal).mockRejectedValueOnce(new Error('Unable to open https://example.com/?token=review-secret'))
    wc.emit('context-menu', {
      linkURL: 'https://example.com/?token=review-secret',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    await (template[0].click as () => void | Promise<void>)()

    // Every logged argument must be checked, not only call[0].
    const logged = spy.mock.calls.map((call) => call.map((arg) => String(arg)).join(' ')).join(' ')
    expect(logged).not.toContain('token=review-secret')
    expect(logged).not.toContain('https://example.com')
    expect(logged).toContain('Failed to open external link')

    spy.mockRestore()
  })

  it('context-menu path deduplicates overlapping user actions when remote guards are attached', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    let resolveFirst: (() => void) | null = null
    vi.mocked(electron.shell.openExternal).mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve }))

    const first = (template[0].click as () => void | Promise<void>)()
    const second = (template[0].click as () => void | Promise<void>)()
    await Promise.resolve()
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await first
    await second
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('context-menu path blocks null, foreign and subframe frames when remote guards are attached', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')

    const nullEvent = wc.emit('context-menu', {
      linkURL: 'https://example.com/',
      frame: null,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(nullEvent.defaultPrevented).toBe(false)

    const foreignFrame = { parent: null, url: 'https://evil.example.com/' }
    const foreignEvent = wc.emit('context-menu', {
      linkURL: 'https://example.com/',
      frame: foreignFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(foreignEvent.defaultPrevented).toBe(false)

    const subframe = { parent: wc.mainFrame, url: 'https://webtp.whatsapp.net/' }
    const subframeEvent = wc.emit('context-menu', {
      linkURL: 'https://example.com/',
      frame: subframe,
      pageURL: 'https://web.whatsapp.com/',
      frameURL: 'https://webtp.whatsapp.net/',
    })
    expect(subframeEvent.defaultPrevented).toBe(false)

    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path blocks service-origin, unsafe and subframe links', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')

    const serviceEvent = wc.emit('context-menu', {
      linkURL: 'https://web.whatsapp.com/chat',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(serviceEvent.defaultPrevented).toBe(false)

    const unsafeEvent = wc.emit('context-menu', {
      linkURL: 'https://user:pass@evil.com/',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(unsafeEvent.defaultPrevented).toBe(false)

    const subframe = { parent: wc.mainFrame, url: 'https://webtp.whatsapp.net/' }
    const subframeEvent = wc.emit('context-menu', {
      linkURL: 'https://example.com/',
      frame: subframe,
      pageURL: 'https://web.whatsapp.com/',
      frameURL: 'https://webtp.whatsapp.net/',
    })
    expect(subframeEvent.defaultPrevented).toBe(false)

    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path opens only once even when a popup or navigation overlaps the menu click', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    vi.mocked(electron.shell.openExternal).mockResolvedValueOnce(undefined)

    // Simulate an overlapping popup request at the moment the menu is clicked.
    // The popup is denied by the existing guard; the explicit menu selection
    // must still result in exactly one browser open.
    const click = (template[0].click as () => void | Promise<void>)()
    const popupResult = wc.windowOpenHandlers[wc.windowOpenHandlers.length - 1]({ url: 'https://example.com/article' })
    expect(popupResult).toEqual({ action: 'deny' })

    // Simulate a concurrent off-origin navigation (e.g. delayed redirect) that is
    // also blocked by the existing guard.
    const navEvent = wc.emitWillNavigate('https://evil.example.com/redirect')
    expect(navEvent.defaultPrevented).toBe(true)

    await click

    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('context-menu path rejects when the live frame URL changes to a foreign origin before click', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]

    // Attacker controlled page changed frame.url to a foreign origin; only
    // pageURL/getURL still claim service. The callback must re-check live frame.url.
    wc.mainFrame.url = 'https://foreign.example/'
    await (template[0].click as () => void | Promise<void>)()

    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path does not open browser after navigation away', async () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')
    wc.emit('context-menu', {
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalled()
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]

    // Simulate a navigation away between menu creation and click.
    wc.setURL('https://evil.example.com/')
    await (template[0].click as () => void | Promise<void>)()

    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('context-menu path does not open browser for the two automatic WhatsApp URLs', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.whatsapp.com/')

    const pdfEvent = wc.emit('context-menu', {
      linkURL: 'https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(pdfEvent.defaultPrevented).toBe(false)

    const flowsEvent = wc.emit('context-menu', {
      linkURL: 'https://flows.whatsapp.net/flows/cache_management/',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(flowsEvent.defaultPrevented).toBe(false)

    expect(electron.Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('still blocks all popup requests via setWindowOpenHandler', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    const result = wc.windowOpenHandlers[0]({ url: 'https://example.com/article' })
    expect(result).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('allows Slack login, app and workspace navigation and blocks foreign origins', () => {
    const messenger = createMessengerView(
      makeAccount('slack'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    expect(wc.emitWillNavigate('https://app.slack.com/client').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://slack.com/signin').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://acmeinc.slack.com/').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://acmeinc.slack.com/messages').defaultPrevented).toBe(false)
    expect(wc.emitWillRedirect('https://app.slack.com/client/T123').defaultPrevented).toBe(false)
    expect(wc.emitWillRedirect('https://acmeinc.slack.com/messages/C123').defaultPrevented).toBe(false)
    expect(wc.emitWillFrameNavigate('https://acmeinc.slack.com/ssb/fallback').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://acmeinc-slack.com/').defaultPrevented).toBe(true)
    expect(wc.emitWillNavigate('https://acmeinc.slack.com.evil.com/').defaultPrevented).toBe(true)
    expect(wc.emitWillNavigate('https://acmeinc.slack.com:8080/').defaultPrevented).toBe(true)
    expect(wc.emitWillNavigate('https://user:pass@acmeinc.slack.com/').defaultPrevented).toBe(true)
    expect(wc.emitWillNavigate('https://evil.example.com/').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://acmeinc-slack.com/redirect').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://acmeinc.slack.com.evil.com/redirect').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://acmeinc.slack.com:8080/redirect').defaultPrevented).toBe(true)
    expect(wc.emitWillRedirect('https://user:pass@acmeinc.slack.com/redirect').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://acmeinc-slack.com/frame').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://acmeinc.slack.com.evil.com/frame').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://acmeinc.slack.com:8080/frame').defaultPrevented).toBe(true)
    expect(wc.emitWillFrameNavigate('https://user:pass@acmeinc.slack.com/frame').defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('allows Discord navigation within discord.com and blocks foreign origins', () => {
    const messenger = createMessengerView(
      makeAccount('discord'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    expect(wc.emitWillNavigate('https://discord.com/login').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://discord.com/channels/@me').defaultPrevented).toBe(false)
    expect(wc.emitWillNavigate('https://evil.example.com/').defaultPrevented).toBe(true)
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not register the click bridge for Slack or Discord', () => {
    const slack = createMessengerView(
      makeAccount('slack'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const discord = createMessengerView(
      makeAccount('discord'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const slackWc = slack.webContents as unknown as FakeWebContents
    const discordWc = discord.webContents as unknown as FakeWebContents
    expect(slackWc.listeners['ipc-message']).toBeUndefined()
    expect(discordWc.listeners['ipc-message']).toBeUndefined()
    expect(slackWc['__webPreferences']).toMatchObject({ additionalArguments: [], sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(discordWc['__webPreferences']).toMatchObject({ additionalArguments: [], sandbox: true, contextIsolation: true, nodeIntegration: false })
  })

  it('registers the click bridge only for Telegram, not for WhatsApp', () => {
    const telegram = createMessengerView(
      makeAccount('telegram'),
      pathsForMessengerTests(tempRoot),
      { isAccountActive: () => true, userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const whatsapp = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const telegramWc = telegram.webContents as unknown as FakeWebContents
    const whatsappWc = whatsapp.webContents as unknown as FakeWebContents
    expect(telegramWc.listeners['ipc-message']).toHaveLength(1)
    expect(whatsappWc.listeners['ipc-message']).toBeUndefined()
    expect(telegramWc['__webPreferences']).toMatchObject({ additionalArguments: ['--fm-telegram-links'], sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(whatsappWc['__webPreferences']).toMatchObject({ additionalArguments: [] })
  })

  it('Telegram click bridge shows a native confirmation dialog before opening browser', async () => {
    const messenger = createMessengerView(
      makeAccount('telegram'),
      pathsForMessengerTests(tempRoot),
      { isAccountActive: () => true, userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.telegram.org/k/')
    vi.mocked(electron.shell.openExternal).mockResolvedValueOnce(undefined)
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/article', title: 'Example' })
    await Promise.resolve()
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const options = vi.mocked(electron.dialog.showMessageBox).mock.calls[0][1]
    expect(options).toMatchObject({
      type: 'question',
      title: 'Externen Link öffnen',
      message: expect.stringContaining('example.com'),
    })
    expect(options?.message).not.toContain('https://example.com/article')
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('Telegram click bridge does not open browser when user cancels', async () => {
    const messenger = createMessengerView(
      makeAccount('telegram'),
      pathsForMessengerTests(tempRoot),
      { isAccountActive: () => true, userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.telegram.org/k/')
    vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1 })
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/article' })
    await Promise.resolve()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('Telegram click bridge rejects service-origin and unsafe URLs', () => {
    const messenger = createMessengerView(
      makeAccount('telegram'),
      pathsForMessengerTests(tempRoot),
      { isAccountActive: () => true, userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.telegram.org/k/')
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://web.telegram.org/k/#@somechat' })
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'javascript:alert(1)' })
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/?token=' + 'x'.repeat(100000) })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('Telegram click bridge rejects foreign origin, destroyed view and malformed payload', () => {
    const messenger = createMessengerView(
      makeAccount('telegram'),
      pathsForMessengerTests(tempRoot),
      { isAccountActive: () => true, userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    attachRemoteGuards(wc as unknown as Electron.WebContents)

    wc.setURL('https://web.telegram.org/k/')
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 123 })

    wc.setURL('https://evil.example.com/')
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/article' })

    wc.setURL('https://web.telegram.org/k/')
    wc.destroy()
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/article' })

    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not log raw popup URLs that may contain credentials or tokens', () => {
    const messenger = createMessengerView(
      makeAccount('whatsapp'),
      pathsForMessengerTests(tempRoot),
      { userAgentSource: { chrome: '126.0.0.0', os: 'Windows NT 10.0; Win64; x64', electron: '44.5.0' } },
    )
    const wc = messenger.webContents as unknown as FakeWebContents
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })

    wc.windowOpenHandlers[0]({ url: 'https://user:pass@example.com/' })
    wc.windowOpenHandlers[0]({ url: 'https://example.com/?token=secret123' })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()

    const logged = spy.mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('user:pass'))).toBe(false)
    expect(logged.some((line) => line.includes('token=secret123'))).toBe(false)

    spy.mockRestore()
  })
})

describe('isServiceUrl', () => {

  it('allows known service origins and blocks unsupported ones', () => {
    expect(isServiceUrl('https://web.whatsapp.com/')).toBe(true)
    expect(isServiceUrl('https://web.telegram.org/k/')).toBe(true)
    expect(isServiceUrl('https://app.slack.com/client')).toBe(true)
    expect(isServiceUrl('https://slack.com/signin')).toBe(true)
    expect(isServiceUrl('https://acmeinc.slack.com/')).toBe(true)
    expect(isServiceUrl('https://discord.com/login')).toBe(true)
    expect(isServiceUrl('https://example.com/')).toBe(false)
    expect(isServiceUrl('https://acmeinc-slack.com/')).toBe(false)
    expect(isServiceUrl('https://acmeinc.slack.com.evil.com/')).toBe(false)
    expect(isServiceUrl('https://acmeinc.slack.com:8080/')).toBe(false)
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
      moveAccount: vi.fn(),
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
    expect(channels).toContain('move-account')
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

  it('routes add-account for Slack, Discord and WhatsApp Business from shell main frame', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'add-account')?.[1] as
      | ((event: unknown, serviceId: string, name?: string) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'slack', 'Workspace')
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'discord', 'Server')
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'whatsapp-business', 'Shop')
    expect(deps.addAccount).toHaveBeenCalledWith('slack', 'Workspace')
    expect(deps.addAccount).toHaveBeenCalledWith('discord', 'Server')
    expect(deps.addAccount).toHaveBeenCalledWith('whatsapp-business', 'Shop')
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

  it('routes move-account from shell main frame with valid direction', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'move-account')?.[1] as
      | ((event: unknown, accountId: string, direction: 'up' | 'down') => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram', 'up')
    expect(deps.moveAccount).toHaveBeenCalledWith('legacy-telegram', 'up')
  })

  it('rejects move-account from remote webContents', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'move-account')?.[1] as
      | ((event: unknown, accountId: string, direction: 'up' | 'down') => void)
    const remoteWc = makeFakeWebContents({ url: 'https://web.whatsapp.com/' })
    handler?.({ sender: remoteWc as unknown as Electron.WebContents, senderFrame: remoteWc.mainFrame }, 'legacy-telegram', 'up')
    expect(deps.moveAccount).not.toHaveBeenCalled()
  })

  it('rejects invalid account ids in move-account', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'move-account')?.[1] as
      | ((event: unknown, accountId: unknown, direction: unknown) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    const cases: unknown[] = ['not-a-uuid', 'path/traversal', '../../etc', 123, null]
    for (const bad of cases) {
      handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, bad, 'up')
    }
    expect(deps.moveAccount).not.toHaveBeenCalled()
  })

  it('rejects invalid directions in move-account', () => {
    const deps = depsFactory()
    registerIpcHandlers(deps)
    const handler = electron.ipcMain.on.mock.calls.find((call) => call[0] === 'move-account')?.[1] as
      | ((event: unknown, accountId: unknown, direction: unknown) => void)
    const shellWc = deps.shellViewRef.current!.webContents as unknown as FakeWebContents
    const cases: unknown[] = ['left', 'top', 1, true, null, undefined]
    for (const bad of cases) {
      handler?.({ sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }, 'legacy-telegram', bad)
    }
    expect(deps.moveAccount).not.toHaveBeenCalled()
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
    accountBadges: new Set(),
    focusDiagnostic: null,
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
      // Badge for the removed account must be gone.
      expect(state.accountBadges.has('legacy-telegram')).toBe(false)
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

  it('creates distinct sessions for two whatsapp-business accounts', async () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    const firstBusinessId = '12345678-1234-1234-1234-1234567890ab'
    const secondBusinessId = '12345678-1234-1234-1234-1234567890ac'
    state.serviceConfig.accounts.push(
      { accountId: firstBusinessId, serviceId: 'whatsapp-business', displayName: 'Shop 1', enabled: true },
      { accountId: secondBusinessId, serviceId: 'whatsapp-business', displayName: 'Shop 2', enabled: true },
    )

    runtime.showAccount(firstBusinessId)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    runtime.showAccount(secondBusinessId)
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const firstProfile = path.join('/app/data/profiles', 'accounts', firstBusinessId)
    const secondProfile = path.join('/app/data/profiles', 'accounts', secondBusinessId)
    expect(mockSessions.has(firstProfile)).toBe(true)
    expect(mockSessions.has(secondProfile)).toBe(true)
    expect(firstProfile).not.toEqual(secondProfile)
  })

  function getLastAccountsPayload (shellWc: FakeWebContents): { accounts: Array<{ accountId: string; serviceId: string; displayName: string; enabled: boolean }>; accountBadges?: string[]; saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly' } | undefined {
    const calls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    if (calls.length === 0) return undefined
    return calls[calls.length - 1][1] as { accounts: Array<{ accountId: string; serviceId: string; displayName: string; enabled: boolean }>; accountBadges?: string[]; saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly' }
  }

  function getLastShellStatePayload (shellWc: FakeWebContents): { activeAccountId: string | null } | undefined {
    const calls = shellWc.send.mock.calls.filter((call) => call[0] === 'shell-state')
    if (calls.length === 0) return undefined
    return calls[calls.length - 1][1] as { activeAccountId: string | null }
  }

  function makeShellEvent (shellWc: FakeWebContents): { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain } {
    return { sender: shellWc as unknown as Electron.WebContents, senderFrame: shellWc.mainFrame }
  }

  function getLastIpcOnHandler (channel: string): (...args: unknown[]) => void {
    const calls = vi.mocked(electron.ipcMain.on).mock.calls.filter((c) => c[0] === channel)
    if (calls.length === 0) throw new Error(`No ipcMain.on handler registered for ${channel}`)
    return calls[calls.length - 1][1]
  }

  function getLastIpcHandleHandler (channel: string): (...args: unknown[]) => unknown {
    const calls = vi.mocked(electron.ipcMain.handle).mock.calls.filter((c) => c[0] === channel)
    if (calls.length === 0) throw new Error(`No ipcMain.handle handler registered for ${channel}`)
    return calls[calls.length - 1][1]
  }

  function selectAccountViaIpc (shellWc: FakeWebContents, accountId: string): void {
    getLastIpcOnHandler('select-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, accountId)
  }

  function startRuntimeFromConfig (portablePaths: Parameters<typeof createRuntime>[0]['portablePaths']): { runtime: ReturnType<typeof createRuntime>; state: RuntimeState; shellWc: FakeWebContents } {
    const loadResult = loadServiceConfig(portablePaths)
    const state: RuntimeState = {
      mainWindow: null,
      shellView: null,
      messengers: new Map(),
      activeAccountId: null,
      showingHome: false,
      serviceConfig: loadResult.ok ? loadResult.config : defaultConfig(),
      lastConfigSaveError: 'none',
      trayController: null,
      accountBadges: new Set(),
      focusDiagnostic: null,
    }
    const runtime = createRuntime({
      app: { isPackaged: false } as unknown as Electron.App,
      state,
      rendererRoot: '/out/renderer',
      portablePaths,
      preloadPath: '/out/preload/preload.cjs',
      userAgentSource: { chrome: '126.0.0.0', electron: '44.5.0' },
    })
    runtime.createWindow()
    runtime.registerIpc()
    const shellWc = getShellFakeWebContents(state)
    shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)
    return { runtime, state, shellWc }
  }

  it('moves mixed accounts up and down over IPC while preserving active messenger, selection and sessions', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'move-account-active-'))
    try {
      const { runtime, state, portablePaths } = makeRuntime({ portablePaths: pathsForMessengerTests(dir) })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      // Add Slack and Discord to the default WhatsApp/Telegram list.
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'slack', 'Workspace')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'discord', 'Server')
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const initialOrder = ['whatsapp', 'telegram', 'slack', 'discord']
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(initialOrder)
      expect(getLastAccountsPayload(shellWc)?.accounts.map((a) => a.serviceId)).toEqual(initialOrder)

      // Select WhatsApp to create an actual messenger and isolated session.
      const whatsappId = state.serviceConfig.accounts.find((a) => a.serviceId === 'whatsapp')!.accountId
      selectAccountViaIpc(shellWc, whatsappId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.activeAccountId).toBe(whatsappId)
      expect(state.messengers.size).toBe(1)
      const whatsappEntry = state.messengers.get(whatsappId)!
      const whatsappProfile = path.join(portablePaths.profiles, 'whatsapp')
      expect(mockSessions.has(whatsappProfile)).toBe(true)
      const loadUrlCallsBeforeMoves = (whatsappEntry.messenger.view.webContents as unknown as FakeWebContents).loadURL.mock.calls.length
      const selectedBefore = state.serviceConfig.selectedAccountId

      // Move Discord up twice immediately (no timer between the two IPC calls).
      const discordId = state.serviceConfig.accounts.find((a) => a.serviceId === 'discord')!.accountId
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, discordId, 'up')
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, discordId, 'up')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const reorderedOrder = ['whatsapp', 'discord', 'telegram', 'slack']
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(reorderedOrder)

      // Active selection and the underlying messenger object stay unchanged.
      expect(state.activeAccountId).toBe(whatsappId)
      expect(state.serviceConfig.selectedAccountId).toBe(selectedBefore)
      expect(state.messengers.get(whatsappId)!.messenger).toBe(whatsappEntry.messenger)
      expect(mockSessions.has(whatsappProfile)).toBe(true)
      expect((state.messengers.get(whatsappId)!.messenger.view.webContents as unknown as FakeWebContents).loadURL.mock.calls.length).toBe(loadUrlCallsBeforeMoves)

      // Sidebar payload reflects the same relative order as the home page.
      expect(getLastAccountsPayload(shellWc)?.accounts.map((a) => a.serviceId)).toEqual(reorderedOrder)

      // Move Telegram down one position.
      const telegramId = state.serviceConfig.accounts.find((a) => a.serviceId === 'telegram')!.accountId
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, telegramId, 'down')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'discord', 'slack', 'telegram'])
      expect(state.activeAccountId).toBe(whatsappId)
      expect(state.messengers.get(whatsappId)!.messenger).toBe(whatsappEntry.messenger)

      // Persisted config reflects the new order and unchanged selection.
      const saved = JSON.parse(fs.readFileSync(portablePaths.configFile, 'utf8'))
      expect(saved.accounts.map((a: { serviceId: string }) => a.serviceId)).toEqual(['whatsapp', 'discord', 'slack', 'telegram'])
      expect(saved.selectedAccountId).toBe(whatsappId)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reordering survives disable, re-enable, add, delete and restart', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'move-account-lifecycle-'))
    try {
      const { runtime, state, portablePaths } = makeRuntime({ portablePaths: pathsForMessengerTests(dir) })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      // Setup order: whatsapp, telegram, slack, discord.
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'slack', 'Workspace')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'discord', 'Server')
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const telegramId = state.serviceConfig.accounts.find((a) => a.serviceId === 'telegram')!.accountId
      const slackId = state.serviceConfig.accounts.find((a) => a.serviceId === 'slack')!.accountId
      const discordId = state.serviceConfig.accounts.find((a) => a.serviceId === 'discord')!.accountId

      // Move Telegram to the end: whatsapp, slack, discord, telegram.
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, telegramId, 'down')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, telegramId, 'down')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'discord', 'telegram'])

      // Disable Slack in the middle; its position is retained and the sidebar still receives it in place.
      getLastIpcOnHandler('set-account-enabled')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, slackId, false)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.find((a) => a.accountId === slackId)?.enabled).toBe(false)
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'discord', 'telegram'])
      expect(getLastAccountsPayload(shellWc)?.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'discord', 'telegram'])

      // Move Discord down past the disabled Slack: whatsapp, slack, telegram, discord.
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, discordId, 'down')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'discord'])

      // Re-enable Slack; order stays the same.
      getLastIpcOnHandler('set-account-enabled')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, slackId, true)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.find((a) => a.accountId === slackId)?.enabled).toBe(true)
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'discord'])

      // Add a new account; it is appended at the end.
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'whatsapp-business', 'Business')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'discord', 'whatsapp-business'])

      // Delete an account in the middle; remaining order is preserved.
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await getLastIpcHandleHandler('remove-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainInvokeEvent, discordId)
      expect(state.serviceConfig.accounts.some((a) => a.accountId === discordId)).toBe(false)
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'whatsapp-business'])

      // Persisted config reflects all changes.
      const saved = JSON.parse(fs.readFileSync(portablePaths.configFile, 'utf8'))
      expect(saved.accounts.map((a: { serviceId: string }) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'whatsapp-business'])

      // Restart restores the same order and sends it to the sidebar.
      const restarted = startRuntimeFromConfig(portablePaths)
      expect(restarted.state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'whatsapp-business'])
      expect(getLastAccountsPayload(restarted.shellWc)?.accounts.map((a) => a.serviceId)).toEqual(['whatsapp', 'slack', 'telegram', 'whatsapp-business'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid and untrusted move-account IPC requests without changing persisted order', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'move-account-security-'))
    try {
      const { runtime, state, portablePaths } = makeRuntime({ portablePaths: pathsForMessengerTests(dir) })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      // Setup order: whatsapp, telegram, slack, discord.
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'slack', 'Workspace')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, 'discord', 'Server')
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const expectedOrder = ['whatsapp', 'telegram', 'slack', 'discord']
      const configBefore = fs.readFileSync(portablePaths.configFile, 'utf8')
      const telegramId = state.serviceConfig.accounts.find((a) => a.serviceId === 'telegram')!.accountId

      // Remote sender must be ignored.
      const remoteWc = makeFakeWebContents({ url: 'https://web.whatsapp.com/' })
      getLastIpcOnHandler('move-account')({ sender: remoteWc as unknown as Electron.WebContents, senderFrame: remoteWc.mainFrame } as unknown as Electron.IpcMainEvent, telegramId, 'up')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(expectedOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)

      // Subframe sender must be ignored.
      const subFrame = { parent: shellWc.mainFrame, url: pathToFileURL('/out/renderer/index.html').href } as unknown as Electron.WebFrameMain
      getLastIpcOnHandler('move-account')({ sender: shellWc as unknown as Electron.WebContents, senderFrame: subFrame } as unknown as Electron.IpcMainEvent, telegramId, 'up')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(expectedOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)

      // Invalid/malformed account id or direction must be ignored.
      const badInputs: Array<[unknown, unknown]> = [
        ['not-a-valid-id', 'up'],
        ['../../etc', 'up'],
        [telegramId, 'left'],
        [telegramId, 1],
        [null, 'up'],
        [telegramId, null],
        [undefined, undefined],
      ]
      for (const [badId, badDir] of badInputs) {
        getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, badId, badDir)
      }
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(expectedOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)

      // Unknown but well-formed account id must be ignored.
      const unknownId = '00000000-0000-0000-0000-000000000000'
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, unknownId, 'up')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(expectedOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)

      // Boundary move must be ignored.
      const whatsappId = state.serviceConfig.accounts.find((a) => a.serviceId === 'whatsapp')!.accountId
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, whatsappId, 'up')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(expectedOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not apply move-account to in-memory order when config is read-only future version', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'move-account-readonly-'))
    try {
      // Seed a future-version config that the runtime must treat as read-only.
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'data', 'services.json'), JSON.stringify({ version: 999, accounts: [] }), 'utf8')

      const portablePaths = pathsForMessengerTests(dir)
      const { runtime, state } = makeRuntime({ portablePaths })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      const initialOrder = state.serviceConfig.accounts.map((a) => a.serviceId)
      const configBefore = fs.readFileSync(portablePaths.configFile, 'utf8')

      const whatsappId = state.serviceConfig.accounts.find((a) => a.serviceId === 'whatsapp')!.accountId
      getLastIpcOnHandler('move-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, whatsappId, 'down')
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      // Order and on-disk config must remain unchanged; UI receives a read-only error.
      expect(state.serviceConfig.accounts.map((a) => a.serviceId)).toEqual(initialOrder)
      expect(fs.readFileSync(portablePaths.configFile, 'utf8')).toBe(configBefore)
      expect(getLastAccountsPayload(shellWc)?.saveError).toBe('future-version-readonly')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['slack', 'discord', 'whatsapp-business'])('runs full add/select/rename/disable/delete lifecycle for %s over IPC and persists it', async (serviceId) => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `lifecycle-${serviceId}-`))
    try {
      const { runtime, state, portablePaths } = makeRuntime({ portablePaths: pathsForMessengerTests(dir) })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      // Add account manually via the registered IPC handler.
      getLastIpcOnHandler('add-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, serviceId, 'Test')
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const account = state.serviceConfig.accounts.find((a) => a.serviceId === serviceId)
      expect(account).toBeDefined()
      expect(account!.displayName).toBe('Test')
      expect(account!.enabled).toBe(true)
      const accountsAfterAdd = getLastAccountsPayload(shellWc)
      expect(accountsAfterAdd?.accounts.some((a) => a.accountId === account!.accountId && a.displayName === 'Test' && a.enabled)).toBe(true)

      // Select the new account through the registered IPC handler.
      selectAccountViaIpc(shellWc, account!.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.activeAccountId).toBe(account!.accountId)
      expect(state.messengers.has(account!.accountId)).toBe(true)
      expect(getLastShellStatePayload(shellWc)?.activeAccountId).toBe(account!.accountId)

      // Rename via IPC; the renderer receives an updated accounts payload.
      getLastIpcOnHandler('rename-account')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, account!.accountId, 'Renamed')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.find((a) => a.accountId === account!.accountId)?.displayName).toBe('Renamed')
      const accountsAfterRename = getLastAccountsPayload(shellWc)
      expect(accountsAfterRename?.accounts.find((a) => a.accountId === account!.accountId)?.displayName).toBe('Renamed')

      // Disable the active account via IPC; it must return home.
      getLastIpcOnHandler('set-account-enabled')(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, account!.accountId, false)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(state.serviceConfig.accounts.find((a) => a.accountId === account!.accountId)?.enabled).toBe(false)
      expect(state.activeAccountId).toBeNull()
      expect(state.showingHome).toBe(true)
      expect(getLastAccountsPayload(shellWc)?.accounts.find((a) => a.accountId === account!.accountId)?.enabled).toBe(false)
      expect(getLastShellStatePayload(shellWc)?.activeAccountId).toBeNull()

      // Persisted config is already saved. Simulate a restart by loading it into a fresh runtime.
      const restarted = startRuntimeFromConfig(portablePaths)
      const loadedAccount = restarted.state.serviceConfig.accounts.find((a) => a.serviceId === serviceId)
      expect(loadedAccount).toBeDefined()
      expect(loadedAccount!.displayName).toBe('Renamed')
      expect(loadedAccount!.enabled).toBe(false)
      expect(restarted.state.messengers.has(loadedAccount!.accountId)).toBe(false)

      // Re-enable and select the restored account through IPC.
      getLastIpcOnHandler('set-account-enabled')(makeShellEvent(restarted.shellWc) as unknown as Electron.IpcMainEvent, loadedAccount!.accountId, true)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(restarted.state.serviceConfig.accounts.find((a) => a.accountId === loadedAccount!.accountId)?.enabled).toBe(true)
      expect(getLastAccountsPayload(restarted.shellWc)?.accounts.find((a) => a.accountId === loadedAccount!.accountId)?.enabled).toBe(true)

      selectAccountViaIpc(restarted.shellWc, loadedAccount!.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(restarted.state.activeAccountId).toBe(loadedAccount!.accountId)
      expect(restarted.state.messengers.has(loadedAccount!.accountId)).toBe(true)
      const restoredProfile = path.join(portablePaths.profiles, 'accounts', loadedAccount!.accountId)
      expect(mockSessions.has(restoredProfile)).toBe(true)
      expect(getLastShellStatePayload(restarted.shellWc)?.activeAccountId).toBe(loadedAccount!.accountId)

      // Delete the account via IPC after explicit confirmation.
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const removeResult = await getLastIpcHandleHandler('remove-account')(makeShellEvent(restarted.shellWc) as unknown as Electron.IpcMainInvokeEvent, loadedAccount!.accountId)
      expect(removeResult).toBe(true)
      expect(restarted.state.serviceConfig.accounts.some((a) => a.accountId === loadedAccount!.accountId)).toBe(false)
      expect(restarted.state.messengers.has(loadedAccount!.accountId)).toBe(false)
      expect(getLastAccountsPayload(restarted.shellWc)?.accounts.some((a) => a.accountId === loadedAccount!.accountId)).toBe(false)
      expect(getLastShellStatePayload(restarted.shellWc)?.activeAccountId).toBeNull()

      // Persisted config reflects the removal.
      const saved = JSON.parse(fs.readFileSync(portablePaths.configFile, 'utf8'))
      expect(saved.accounts.some((a: { accountId: string }) => a.accountId === loadedAccount!.accountId)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['slack', 'discord', 'whatsapp-business'])('isolates two manually added %s accounts in distinct sessions and restores them after restart', async (serviceId) => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `isolation-${serviceId}-`))
    try {
      const { runtime, state, portablePaths } = makeRuntime({ portablePaths: pathsForMessengerTests(dir) })
      runtime.createWindow()
      runtime.registerIpc()
      const shellWc = getShellFakeWebContents(state)
      shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
      const didFinishLoad = shellWc.onceListeners['did-finish-load']?.[0]
      didFinishLoad?.({} as unknown as FakeEvent)

      const addHandler = getLastIpcOnHandler('add-account')
      addHandler(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, serviceId, 'A')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const accountA = state.serviceConfig.accounts.find((a) => a.serviceId === serviceId && a.displayName === 'A')!
      addHandler(makeShellEvent(shellWc) as unknown as Electron.IpcMainEvent, serviceId, 'B')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const accountB = state.serviceConfig.accounts.find((a) => a.serviceId === serviceId && a.displayName === 'B')!

      // Select both accounts through the registered IPC handler.
      selectAccountViaIpc(shellWc, accountA.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      selectAccountViaIpc(shellWc, accountB.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const profileA = path.join(portablePaths.profiles, 'accounts', accountA.accountId)
      const profileB = path.join(portablePaths.profiles, 'accounts', accountB.accountId)
      expect(mockSessions.has(profileA)).toBe(true)
      expect(mockSessions.has(profileB)).toBe(true)
      expect(profileA).not.toEqual(profileB)
      expect(mockSessions.get(profileA)).not.toBe(mockSessions.get(profileB))

      // Restart from the persisted config and verify both accounts are restored with distinct sessions.
      const restarted = startRuntimeFromConfig(portablePaths)
      const loadedA = restarted.state.serviceConfig.accounts.find((a) => a.accountId === accountA.accountId)!
      const loadedB = restarted.state.serviceConfig.accounts.find((a) => a.accountId === accountB.accountId)!
      expect(loadedA).toBeDefined()
      expect(loadedB).toBeDefined()
      expect(loadedA.displayName).toBe('A')
      expect(loadedB.displayName).toBe('B')

      // Before any manual IPC, the runtime must have auto-restored the last selected account (B).
      expect(restarted.state.serviceConfig.selectedAccountId).toBe(accountB.accountId)
      expect(restarted.state.activeAccountId).toBe(accountB.accountId)
      expect(getLastShellStatePayload(restarted.shellWc)?.activeAccountId).toBe(accountB.accountId)
      const autoRestoredProfileB = path.join(portablePaths.profiles, 'accounts', loadedB.accountId)
      expect(mockSessions.has(autoRestoredProfileB)).toBe(true)

      selectAccountViaIpc(restarted.shellWc, loadedA.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      selectAccountViaIpc(restarted.shellWc, loadedB.accountId)
      await new Promise((resolve) => { setTimeout(resolve, 0) })

      const restartedProfileA = path.join(portablePaths.profiles, 'accounts', loadedA.accountId)
      const restartedProfileB = path.join(portablePaths.profiles, 'accounts', loadedB.accountId)
      expect(mockSessions.has(restartedProfileA)).toBe(true)
      expect(mockSessions.has(restartedProfileB)).toBe(true)
      expect(mockSessions.get(restartedProfileA)).not.toBe(mockSessions.get(restartedProfileB))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

  it('does not set a badge for a disabled account from the bridge', () => {
    const { runtime, state } = makeRuntime()
    runtime.createWindow()
    const didFinishLoad = getShellFakeWebContents(state).onceListeners['did-finish-load']?.[0]
    didFinishLoad?.({} as unknown as FakeEvent)

    runtime.showAccount('legacy-whatsapp')
    // Disable the account after the messenger view (and its bridge) was created.
    state.serviceConfig = {
      ...state.serviceConfig,
      accounts: state.serviceConfig.accounts.map((a) =>
        a.accountId === 'legacy-whatsapp' ? { ...a, enabled: false } : a,
      ),
    }

    const whatsappWc = state.messengers.get('legacy-whatsapp')?.messenger.view.webContents as unknown as FakeWebContents
    whatsappWc.emit('ipc-message', { senderFrame: whatsappWc.mainFrame }, FM_NOTIFICATION_BRIDGE, {
      title: 'Max',
      body: 'Hallo',
      tag: 't',
      icon: '',
    })
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(false)
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

describe('Telegram links through actual runtime account actions', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'telegram-runtime-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })
  it.each(['disabled', 'removed'])('revokes pending link after registered %s account action', async mode => {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow(); runtime.registerIpc(); runtime.showAccount('legacy-telegram')
    const wc = state.messengers.get('legacy-telegram')!.messenger.webContents as unknown as FakeWebContents
    wc.setURL('https://web.telegram.org/k/')
    let confirmLink!: (result: { response: number; checkboxChecked: boolean }) => void
    vi.mocked(electron.dialog.showMessageBox).mockImplementationOnce(() => new Promise(resolve => { confirmLink = resolve }))
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/' })
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const shell = state.shellView!.webContents as unknown as FakeWebContents
    shell.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const event = { sender: shell, senderFrame: shell.mainFrame }
    if (mode === 'disabled') {
      const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'set-account-enabled')![1]
      handler(event as unknown as Electron.IpcMainEvent, 'legacy-telegram', false)
    } else {
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const handler = vi.mocked(electron.ipcMain.handle).mock.calls.find(c => c[0] === 'remove-account')![1]
      expect(await handler(event as unknown as Electron.IpcMainInvokeEvent, 'legacy-telegram')).toBe(true)
    }
    confirmLink({ response: 0, checkboxChecked: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(electron.shell.openExternal).not.toHaveBeenCalled()
    const accountsPayloads = shell.send.mock.calls.filter(c => c[0] === 'accounts')
    expect(accountsPayloads.length).toBeGreaterThan(0)
    expect(state.serviceConfig.accounts.some(a => a.accountId === 'legacy-telegram' && a.enabled)).toBe(false)
    wc.emit('ipc-message', 'fm-safe-link-bridge', { url: 'https://example.com/late' })
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(mode === 'disabled' ? 1 : 2)
  })
})

describe('native audio-only microphone permissions without settings switch', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'audio-permissions-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it.each(['legacy-whatsapp', 'legacy-telegram'])('allows native audio for the enabled live account %s', id => {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow(); runtime.showAccount(id)
    const m = state.messengers.get(id)!.messenger
    const wc = m.webContents as unknown as FakeWebContents
    const url = id === 'legacy-telegram' ? 'https://web.telegram.org/k/' : 'https://web.whatsapp.com/'
    wc.setURL(url)
    const request = vi.mocked(m.session.setPermissionRequestHandler).mock.calls[0][0]!
    const check = vi.mocked(m.session.setPermissionCheckHandler).mock.calls[0][0]!
    const callback = vi.fn()
    request(m.webContents, 'media', callback, { requestingUrl: url, isMainFrame: true, mediaTypes: ['audio'] } as Electron.MediaAccessPermissionRequest)
    expect(callback).toHaveBeenCalledWith(true)
    expect(check(m.webContents, 'media', new URL(url).origin, { isMainFrame: true, mediaType: 'audio' })).toBe(true)
  })

  it.each(['video', 'mixed', 'empty', 'subframe', 'foreign', 'disabled', 'unregistered', 'destroyed', 'detached', 'disposed', 'stale', 'blank', 'credentials', 'http', 'display'])('denies %s capture through the actual registered handlers', mode => {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow(); runtime.showAccount('legacy-telegram')
    const m = state.messengers.get('legacy-telegram')!.messenger
    const wc = m.webContents as unknown as FakeWebContents
    wc.setURL('https://web.telegram.org/k/')
    let url = 'https://web.telegram.org/k/'
    if (mode === 'foreign') url = 'https://web.whatsapp.com/'
    if (mode === 'disabled') state.serviceConfig.accounts.find(a => a.accountId === 'legacy-telegram')!.enabled = false
    if (mode === 'unregistered') state.messengers.delete('legacy-telegram')
    if (mode === 'destroyed') wc.destroyed = true
    if (mode === 'detached') Object.defineProperty(wc.mainFrame, 'detached', { value: true })
    if (mode === 'disposed') Object.defineProperty(wc.mainFrame, 'url', { get: () => { throw new Error('disposed') } })
    if (mode === 'stale') wc.getURL = () => 'https://web.whatsapp.com/'
    if (mode === 'blank') wc.setURL('about:blank')
    if (mode === 'credentials') url = 'https://user:pass@web.telegram.org/k/'
    if (mode === 'http') url = 'http://web.telegram.org/k/'
    const request = vi.mocked(m.session.setPermissionRequestHandler).mock.calls[0][0]!
    const check = vi.mocked(m.session.setPermissionCheckHandler).mock.calls[0][0]!
    const callback = vi.fn()
    const types = mode === 'mixed' ? ['audio', 'video'] : mode === 'video' ? ['video'] : mode === 'empty' ? [] : ['audio']
    const permission = mode === 'display' ? 'display-capture' : 'media'
    request(m.webContents, permission, callback, { requestingUrl: url, isMainFrame: mode !== 'subframe', mediaTypes: types } as Electron.MediaAccessPermissionRequest)
    expect(callback).toHaveBeenCalledWith(false)
    expect(() => check(m.webContents, permission, url, { isMainFrame: mode !== 'subframe', mediaType: mode === 'mixed' || mode === 'video' ? 'video' : mode === 'empty' ? 'unknown' : 'audio' })).not.toThrow()
    expect(check(m.webContents, permission, url, { isMainFrame: mode !== 'subframe', mediaType: mode === 'mixed' || mode === 'video' ? 'video' : mode === 'empty' ? 'unknown' : 'audio' })).toBe(false)
  })
})

describe('messenger loading overlay preserves editor focus boundaries', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'overlay-runtime-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it.each(['background', 'subframe', 'same-document'])('keeps the active Telegram view visible during %s activity', async mode => {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow(); runtime.showAccount('legacy-telegram')
    await new Promise(resolve => setTimeout(resolve, 0))
    const entry = state.messengers.get('legacy-telegram')!
    const messenger = entry.messenger
    const wc = messenger.webContents as unknown as FakeWebContents
    const view = messenger.view
    const shell = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(view.setVisible).mockClear()
    const loads = wc.loadURL.mock.calls.length
    const navigation = wc.listeners['did-start-navigation']
    if (mode !== 'background') {
      for (const handler of navigation) handler({ isMainFrame: mode === 'same-document', isSameDocument: mode === 'same-document' } as unknown as FakeEvent, 'https://web.telegram.org/k/', mode === 'same-document', mode === 'same-document')
    }
    wc.emit('did-start-loading')
    wc.emit('did-stop-loading')
    expect(entry.loadState.loading).toBe(false)
    expect(entry.loadState.failed).toBe(false)
    expect(state.activeAccountId).toBe('legacy-telegram')
    expect(state.messengers.get('legacy-telegram')!.messenger).toBe(messenger)
    expect(wc.loadURL).toHaveBeenCalledTimes(loads)
    expect(wc.close).not.toHaveBeenCalled()
    expect(view.setVisible).not.toHaveBeenCalledWith(false)
    const payloads = shell.send.mock.calls.filter(c => c[0] === 'shell-state')
    expect(payloads.at(-1)![1]).toMatchObject({ activeAccountId: 'legacy-telegram', loadState: { loading: false, failed: false } })
  })

  it.each(['modern', 'legacy'])('retains the real main-document loading overlay for %s navigation signals', async mode => {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow(); runtime.showAccount('legacy-telegram')
    await new Promise(resolve => setTimeout(resolve, 0))
    const entry = state.messengers.get('legacy-telegram')!
    const wc = entry.messenger.webContents as unknown as FakeWebContents
    if (mode === 'modern') {
      for (const handler of wc.listeners['did-start-navigation']) handler({ isMainFrame: true, isSameDocument: false } as unknown as FakeEvent, 'https://web.telegram.org/k/', false, true)
    } else wc.emit('did-start-navigation', 'https://web.telegram.org/k/', false, true)
    expect(entry.loadState.loading).toBe(true)
    expect(entry.messenger.view.setVisible).toHaveBeenLastCalledWith(false)
    wc.emit('did-stop-loading')
    expect(entry.loadState.loading).toBe(false)
    expect(entry.messenger.view.setVisible).toHaveBeenLastCalledWith(true)
    wc.emit('did-fail-load', { isMainFrame: true }, -105, 'network', '', true)
    expect(entry.loadState.failed).toBe(true)
    expect(entry.messenger.view.setVisible).toHaveBeenLastCalledWith(false)
  })
})

describe('production notification preload to runtime', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'notification-runtime-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  async function setup () {
    const { runtime, state } = makeRuntime({ portablePaths: pathsForMessengerTests(root) })
    runtime.createWindow()
    runtime.registerIpc()
    runtime.showAccount('legacy-whatsapp')
    await new Promise(resolve => setTimeout(resolve, 0))
    const wc = state.messengers.get('legacy-whatsapp')!.messenger.webContents as unknown as FakeWebContents
    wc.setURL('https://web.whatsapp.com/')
    Object.assign(wc.mainFrame, { origin: 'https://web.whatsapp.com', isDestroyed: () => false })
    const mainWorld: Record<string, unknown> = {}
    const send = vi.fn((channel: string, payload: unknown) => {
      for (const handler of wc.listeners['ipc-message'] ?? []) {
        handler({ sender: wc, senderFrame: wc.mainFrame } as unknown as FakeEvent, channel, payload)
      }
    })
    vm.runInNewContext(fs.readFileSync('out/preload/messenger-preload.cjs', 'utf8'), {
      exports: {}, window: {}, require: () => ({
   ipcRenderer: { send, on: vi.fn() },
   contextBridge: {
          exposeInMainWorld: (key: string, api: unknown) => { mainWorld[key] = api },
          executeInMainWorld: (script: { func: () => void }) => {
            vm.runInNewContext(`(${script.func.toString()})()`, { window: mainWorld, EventTarget, Event })
          },
        },
      }),
    })
    const notify = () => {
      const Constructor = mainWorld.Notification as new (title: string, options: { body: string }) => unknown
      return new Constructor('PRIVATE SENDER', { body: 'PRIVATE BODY' })
    }
    return { runtime, state, wc, notify, send, win: state.mainWindow!, portablePaths: pathsForMessengerTests(root) }
  }

  it.each(['visible', 'hidden', 'minimized', 'unfocused', 'loading', 'failed', 'inactive', 'toasts-off'])('runs real visibility decision: %s', async mode => {
    const { state, wc, notify, send, win } = await setup()
    if (mode === 'hidden') vi.mocked(win.isVisible).mockReturnValue(false)
    if (mode === 'minimized') vi.mocked(win.isMinimized).mockReturnValue(true)
    if (mode === 'unfocused') vi.mocked(win.isFocused).mockReturnValue(false)
    if (mode === 'loading') wc.emit('did-start-navigation', 'https://web.whatsapp.com/', false, true)
    if (mode === 'failed') wc.emit('did-fail-load', { isMainFrame: true }, -105, 'network', '', true)
    if (mode === 'inactive') state.activeAccountId = null
    if (mode === 'toasts-off') {
      state.serviceConfig.preferences.notificationsEnabled = false
      vi.mocked(win.isFocused).mockReturnValue(false)
    }
    notify()
    expect(send).toHaveBeenCalledTimes(1)
    const expectToast = mode !== 'visible' && mode !== 'toasts-off'
    expect(electron.Notification).toHaveBeenCalledTimes(expectToast ? 1 : 0)
    if (expectToast) {
      expect(electron.Notification).toHaveBeenCalledWith(expect.objectContaining({ title: 'WhatsApp', body: 'Neue Nachricht' }))
    }
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(mode !== 'visible')
  })

  it('select-account from shell clears a real badge in the last accounts payload', async () => {
    const { state, notify, win } = await setup()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(win.isFocused).mockReturnValue(false)
    notify()
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(true)

    shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'select-account')![1]
    handler({ sender: shellWc, senderFrame: shellWc.mainFrame } as unknown as Electron.IpcMainEvent, 'legacy-whatsapp')

    expect(state.accountBadges.has('legacy-whatsapp')).toBe(false)
    const accountCalls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls.length).toBeGreaterThan(0)
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).not.toContain('legacy-whatsapp')
  })

  it('set-account-enabled false clears a real badge in the last accounts payload', async () => {
    const { state, notify, win } = await setup()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(win.isFocused).mockReturnValue(false)
    notify()
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(true)

    shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'set-account-enabled')![1]
    handler({ sender: shellWc, senderFrame: shellWc.mainFrame } as unknown as Electron.IpcMainEvent, 'legacy-whatsapp', false)

    expect(state.accountBadges.has('legacy-whatsapp')).toBe(false)
    const accountCalls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls.length).toBeGreaterThan(0)
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).not.toContain('legacy-whatsapp')
  })

  it('set-account-enabled false keeps a real badge when save fails', async () => {
    const { state, notify, win, portablePaths } = await setup()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(win.isFocused).mockReturnValue(false)
    notify()
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(true)

    // Block writes by making the config file path a directory.
    fs.rmSync(portablePaths.configFile, { force: true })
    fs.mkdirSync(portablePaths.configFile, { recursive: true })

    shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'set-account-enabled')![1]
    handler({ sender: shellWc, senderFrame: shellWc.mainFrame } as unknown as Electron.IpcMainEvent, 'legacy-whatsapp', false)

    expect(state.serviceConfig.accounts.find(a => a.accountId === 'legacy-whatsapp')?.enabled).toBe(true)
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(true)
    const accountCalls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).toContain('legacy-whatsapp')
  })

  it('set-account-enabled true clears a stale badge in the last accounts payload', async () => {
    const { state, notify, win } = await setup()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(win.isFocused).mockReturnValue(false)
    notify()
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(true)

    shellWc.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'set-account-enabled')![1]
    handler({ sender: shellWc, senderFrame: shellWc.mainFrame } as unknown as Electron.IpcMainEvent, 'legacy-whatsapp', false)
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(false)

    handler({ sender: shellWc, senderFrame: shellWc.mainFrame } as unknown as Electron.IpcMainEvent, 'legacy-whatsapp', true)
    expect(state.serviceConfig.accounts.find(a => a.accountId === 'legacy-whatsapp')?.enabled).toBe(true)
    const accountCalls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls.length).toBeGreaterThan(0)
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).not.toContain('legacy-whatsapp')
  })

  it.each(['disabled', 'removed'])('ignores signals and late toast clicks after real %s IPC and last accounts payload has no badge', async mode => {
    const { state, notify, win } = await setup()
    vi.mocked(win.isVisible).mockReturnValue(false)
    notify()
    const toast = vi.mocked(electron.Notification).mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const click = toast.on.mock.calls.find(c => c[0] === 'click')![1] as () => void
    const shell = state.shellView!.webContents as unknown as FakeWebContents
    shell.mainFrame.url = pathToFileURL('/out/renderer/index.html').href
    const event = { sender: shell, senderFrame: shell.mainFrame }
    if (mode === 'disabled') {
      const handler = vi.mocked(electron.ipcMain.on).mock.calls.find(c => c[0] === 'set-account-enabled')![1]
      handler(event as unknown as Electron.IpcMainEvent, 'legacy-whatsapp', false)
    } else {
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      const handler = vi.mocked(electron.ipcMain.handle).mock.calls.find(c => c[0] === 'remove-account')![1]
      expect(await handler(event as unknown as Electron.IpcMainInvokeEvent, 'legacy-whatsapp')).toBe(true)
    }
    vi.mocked(electron.Notification).mockClear()
    vi.mocked(win.show).mockClear()
    notify()
    click()
    expect(electron.Notification).not.toHaveBeenCalled()
    expect(win.show).not.toHaveBeenCalled()
    expect(state.activeAccountId).toBeNull()
    const accountCalls = shell.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls.length).toBeGreaterThan(0)
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).not.toContain('legacy-whatsapp')
  })

  it('restores and selects an enabled account on native toast click and payload has no badge', async () => {
    const { state, notify, win } = await setup()
    const shellWc = state.shellView!.webContents as unknown as FakeWebContents
    vi.mocked(win.isMinimized).mockReturnValue(true)
    shellWc.send.mockClear()
    notify()
    const toast = vi.mocked(electron.Notification).mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const click = toast.on.mock.calls.find(c => c[0] === 'click')![1] as () => void
    click()
    expect(win.restore).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(state.activeAccountId).toBe('legacy-whatsapp')
    expect(state.accountBadges.has('legacy-whatsapp')).toBe(false)
    const accountCalls = shellWc.send.mock.calls.filter((call) => call[0] === 'accounts')
    expect(accountCalls.length).toBeGreaterThan(0)
    expect(accountCalls[accountCalls.length - 1][1].accountBadges).not.toContain('legacy-whatsapp')
  })

  it.each(['destroyed-wc', 'throwing-frame'])('fails closed before unsafe getters: %s', async mode => {
    const { wc, notify, win } = await setup()
    vi.mocked(win.isVisible).mockReturnValue(false)
    const frame = wc.mainFrame
    const getter = vi.fn(() => { throw new Error('disposed') })
    if (mode === 'destroyed-wc') {
      wc.destroyed = true
      Object.defineProperty(wc, 'getURL', { value: getter })
      Object.defineProperty(frame, 'origin', { get: getter })
    } else Object.defineProperty(frame, 'origin', { get: getter })
    expect(() => notify()).not.toThrow()
    expect(electron.Notification).not.toHaveBeenCalled()
    if (mode === 'destroyed-wc') expect(getter).not.toHaveBeenCalled()
    else expect(getter).toHaveBeenCalled()
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
      accountBadges: new Set(),
      focusDiagnostic: null,
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
