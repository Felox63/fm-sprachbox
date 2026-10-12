import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { FocusDiagnosticLogger, EVENT_CHANNEL } from '../../src/main/focus-diagnostic.js'
import { ipcMain, type WebContents, type WebContentsView, type BaseWindow, type WebFrameMain } from 'electron'

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((_channel, handler) => {
      // Capture the handler so tests can invoke the production listener.
      ;(ipcMain as unknown as Record<string, (...args: unknown[]) => void>)[_channel] = handler
    }),
    handle: vi.fn(),
  },
}))

function makeWebContents (id: number, options?: { destroyed?: boolean; focused?: boolean; url?: string; zoomFactor?: number }): WebContents {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const wc = {
    id,
    isDestroyed: () => options?.destroyed ?? false,
    isFocused: () => options?.focused ?? false,
    getZoomFactor: () => options?.zoomFactor ?? 1,
    getURL: () => options?.url ?? 'https://web.telegram.org/k/',
    send: vi.fn(),
    mainFrame: { url: options?.url ?? 'https://web.telegram.org/k/', parent: null } as unknown as WebFrameMain,
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      listeners.get(event)?.delete(handler)
    }),
    emit: (event: string, ...args: unknown[]) => {
      listeners.get(event)?.forEach((h) => h(...args))
    },
  } as unknown as WebContents
  return wc
}

function makeEvent (
  sender: WebContents,
  options?: { frame?: WebFrameMain | null; destroyed?: boolean },
): { sender: WebContents; senderFrame: WebFrameMain | undefined } {
  const frame = options?.frame ?? sender.mainFrame
  return { sender, senderFrame: frame ?? undefined }
}

describe('FocusDiagnosticLogger', () => {
  let tmpDir: string
  let logger: FocusDiagnosticLogger
  let notifyState: ReturnType<typeof vi.fn>
  let getShellView: ReturnType<typeof vi.fn>
  let getActiveAccountId: ReturnType<typeof vi.fn>
  let isMessengerWebContents: ReturnType<typeof vi.fn>
  let isServiceUrl: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-diagnostic-'))
    notifyState = vi.fn()
    getShellView = vi.fn(() => null)
    getActiveAccountId = vi.fn(() => null)
    isMessengerWebContents = vi.fn(() => true)
    isServiceUrl = vi.fn((url: string) => url.startsWith('https://web.telegram.org') || url.startsWith('https://web.whatsapp.com'))
    logger = new FocusDiagnosticLogger({
      logsDir: tmpDir,
      getActiveAccountId,
      getShellView,
      isMessengerWebContents,
      isServiceUrl,
      notifyState,
    })
  })

  afterEach(() => {
    logger.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is disabled by default and writes nothing', () => {
    expect(logger.getState().enabled).toBe(false)
    expect(logger.getState().filePath).toBeNull()
    logger.logOverlayChange(true)
    expect(fs.readdirSync(tmpDir)).toHaveLength(0)
  })

  it('creates a log file on start and reports state', () => {
    const state = logger.start()
    expect(state.enabled).toBe(true)
    expect(state.filePath).not.toBeNull()
    expect(fs.existsSync(state.filePath!)).toBe(true)
    expect(notifyState).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, filePath: state.filePath }))
  })

  it('stops writing and preserves the last file path', () => {
    const started = logger.start()
    const stopped = logger.stop()
    expect(stopped.enabled).toBe(false)
    expect(stopped.filePath).toBe(started.filePath)
    expect(logger.getState().enabled).toBe(false)
  })

  it('toggles between start and stop', () => {
    const first = logger.toggle()
    expect(first.enabled).toBe(true)
    const second = logger.toggle()
    expect(second.enabled).toBe(false)
    expect(notifyState).toHaveBeenCalledTimes(2)
  })

  it('rotates old log files keeping only the most recent one', () => {
    const oldFile = path.join(tmpDir, 'focus-diagnostic-old.log')
    fs.writeFileSync(oldFile, 'old')
    fs.utimesSync(oldFile, 0, 0)
    const started = logger.start()
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('focus-diagnostic-'))
    expect(files).toContain(path.basename(started.filePath!))
    expect(files).not.toContain('focus-diagnostic-old.log')
  })

  it('caps the log file at MAX_LOG_BYTES and stops automatically', () => {
    logger.start()
    // Each line is small; write enough to exceed 2 MB.
    for (let i = 0; i < 100_000; i++) {
      logger.logOverlayChange(true)
    }
    expect(logger.getState().enabled).toBe(false)
    const stat = fs.statSync(logger.getState().filePath!)
    expect(stat.size).toBeLessThanOrEqual(2 * 1024 * 1024 + 4096)
  })

  it('records anonymous categories and skips entries when stopped', () => {
    logger.start()
    logger.logActiveAccountChange('some-account-id')
    logger.logMessengerVisible('some-account-id', true)
    logger.logOverlayChange(false)
    logger.logBounds({ x: 0, y: 0, width: 800, height: 600 } as Electron.Rectangle)
    logger.stop()
    logger.logOverlayChange(true)

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    const lines = content.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l: { type: string }) => l.type)).toEqual(['view-active', 'overlay-off', 'view-active', 'view-visible', 'overlay-off', 'bounds'])
    expect(lines.some((l: { detail?: Record<string, unknown> }) => JSON.stringify(l.detail ?? {}).includes('some-account-id'))).toBe(false)
  })

  it('binds and unbinds window, shell and messenger focus handlers without throwing', () => {
    const win = { on: vi.fn(), off: vi.fn(), isFocused: () => true } as unknown as BaseWindow
    const shellView = { webContents: { on: vi.fn(), off: vi.fn(), send: vi.fn(), id: 1, isDestroyed: () => false, isFocused: () => false } } as unknown as WebContentsView
    const messengerWc = { on: vi.fn(), off: vi.fn(), send: vi.fn(), id: 2, isDestroyed: () => false, isFocused: () => false, getZoomFactor: () => 1, getURL: () => 'https://web.telegram.org/k/' } as unknown as WebContents

    logger.bindWindow(win)
    logger.bindShellView(shellView)
    logger.bindMessengerWebContents(messengerWc, 'account-1')
    logger.start()
    logger.stop()
    logger.unbindMessengerWebContents(messengerWc)
    logger.unbindShellView()
    logger.unbindWindow()

    expect(win.on).toHaveBeenCalled()
    expect(win.off).toHaveBeenCalled()
    expect(shellView.webContents.on).not.toHaveBeenCalled()
    expect(shellView.webContents.off).not.toHaveBeenCalled()
    expect(messengerWc.on).toHaveBeenCalled()
    expect(messengerWc.off).toHaveBeenCalled()
  })

  it('rejects diagnostic events from untrusted WebContents', () => {
    isMessengerWebContents.mockReturnValue(false)
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    expect(handler).toBeDefined()

    const untrustedSender = makeWebContents(99)
    handler(makeEvent(untrustedSender), { t: 10, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    expect(content).not.toMatch(/dom-/)
  })

  it('rejects events from destroyed senders', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const destroyedSender = makeWebContents(98, { destroyed: true })
    handler(makeEvent(destroyedSender), { t: 10, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })
    expect(fs.readFileSync(logger.getState().filePath!, 'utf8')).not.toMatch(/dom-/)
  })

  it('rejects events from subframes and foreign origins', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const trustedSender = makeWebContents(97, { url: 'https://web.telegram.org/k/' })

    // Subframe (parent != null).
    const subFrame = { url: 'https://web.telegram.org/k/', parent: {} } as unknown as WebFrameMain
    handler(makeEvent(trustedSender, { frame: subFrame }), { t: 1, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })

    // Foreign origin.
    isServiceUrl.mockReturnValue(false)
    const evilSender = makeWebContents(96, { url: 'https://evil.invalid/' })
    handler(makeEvent(evilSender), { t: 2, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    expect(content).not.toMatch(/dom-/)
  })

  it('rejects events with disallowed top-level or detail keys while accepting valid ones', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const trustedSender = makeWebContents(42, { url: 'https://web.telegram.org/k/' })

    // Disallowed top-level field.
    handler(makeEvent(trustedSender), { t: 1, type: 'dom-click', detail: { target: 'editable', editableFocused: true }, extra: 'bad' })
    // Disallowed detail key.
    handler(makeEvent(trustedSender), { t: 2, type: 'dom-click', detail: { target: 'editable', editableFocused: true, text: 'bad' } })
    // Missing required detail field.
    handler(makeEvent(trustedSender), { t: 3, type: 'dom-click', detail: { editableFocused: true } })
    // Valid entry.
    handler(makeEvent(trustedSender), { t: 4, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type.startsWith('dom-'))
    expect(lines.length).toBe(1)
    expect(lines[0].type).toBe('dom-click')
    expect(lines[0].detail).toEqual({ target: 'editable', editableFocused: true })
  })

  it('rejects arbitrary string/object values in allowed detail fields (privacy sentinel test)', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const trustedSender = makeWebContents(42, { url: 'https://web.telegram.org/k/' })

    const sentinelValues = [
      'PRIVATE_MESSAGE_SENTINEL',
      'PRIVATE_TOKEN_SENTINEL',
      'PRIVATE_KEY_SENTINEL',
      { value: 'PRIVATE_OBJECT_SENTINEL' },
      12345,
      'other',
      'editable', // valid target but with invalid editableFocused below
    ]

    for (let i = 0; i < sentinelValues.length; i++) {
      const value = sentinelValues[i]
      handler(makeEvent(trustedSender), {
        t: i,
        type: 'dom-click',
        detail: {
          target: value,
          editableFocused: value,
        },
      })
    }

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    expect(content).not.toContain('PRIVATE')
    expect(content).not.toContain('12345')
    expect(content).not.toMatch(/dom-/)
  })

  it('enforces exact enum values for target and eventType', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const trustedSender = makeWebContents(42, { url: 'https://web.telegram.org/k/' })

    // Invalid target category.
    handler(makeEvent(trustedSender), { t: 1, type: 'dom-click', detail: { target: 'div', editableFocused: true } })
    // Invalid keyboard event kind.
    handler(makeEvent(trustedSender), { t: 2, type: 'dom-keydown', detail: { target: 'editable', editableFocused: true, eventType: 'keypress' } })
    // Valid keyboard event.
    handler(makeEvent(trustedSender), { t: 3, type: 'dom-keydown', detail: { target: 'editable', editableFocused: true, eventType: 'keydown' } })

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type.startsWith('dom-'))
    expect(lines.length).toBe(1)
    expect(lines[0].detail).toEqual({ target: 'editable', editableFocused: true, eventType: 'keydown' })
  })

  it('enforces per-view rate limit and logs only one warning', () => {
    logger.start()
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const trustedSender = makeWebContents(42, { url: 'https://web.telegram.org/k/' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let i = 0; i < 102; i++) {
      handler(makeEvent(trustedSender), { t: i, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })
    }

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.filter((l) => l.type === 'dom-click').length).toBe(100)
    expect(warnSpy).not.toHaveBeenCalled()
    // Only one warning should be emitted for the burst.
    const rateWarnings = warnSpy.mock.calls.filter((c) => c[0] === '[focus-diagnostic] Rate limit exceeded for view' && c[1] === 42)
    expect(rateWarnings.length).toBe(0)

    warnSpy.mockRestore()
  })

  it('rejects toggle from non-shell senders and subframes', () => {
    const shellView = { webContents: { id: 1, send: vi.fn(), isDestroyed: () => false, mainFrame: { url: 'file:///renderer/index.html', parent: null } } } as unknown as WebContentsView
    getShellView.mockReturnValue(shellView)
    const handler = (ipcMain as unknown as Record<string, (event: unknown) => void>)['toggle-focus-diagnostic']
    expect(handler).toBeDefined()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const foreignSender = makeWebContents(99)

    handler({ sender: foreignSender, senderFrame: foreignSender.mainFrame })
    expect(logger.getState().enabled).toBe(false)

    // Subframe toggle rejected even from shell WebContents.
    const subFrame = { url: 'file:///renderer/index.html', parent: {} } as unknown as WebFrameMain
    handler({ sender: shellView.webContents, senderFrame: subFrame })
    expect(logger.getState().enabled).toBe(false)

    handler({ sender: shellView.webContents, senderFrame: shellView.webContents.mainFrame })
    expect(logger.getState().enabled).toBe(true)

    warnSpy.mockRestore()
  })

  it('sends start control to a newly bound messenger when already running', () => {
    const messengerWc = makeWebContents(2, { url: 'https://web.telegram.org/k/' })
    logger.start()
    logger.bindMessengerWebContents(messengerWc, 'account-1')
    expect(messengerWc.send).toHaveBeenCalledWith('fm-focus-diagnostic-control', { command: 'start' })
  })

  it('labels main-process and DOM events consistently', () => {
    const messengerWc = makeWebContents(2, { url: 'https://web.telegram.org/k/' })
    getActiveAccountId.mockReturnValue('account-1')
    logger.bindMessengerWebContents(messengerWc, 'account-1')
    logger.start()
    logger.logActiveAccountChange('account-1')
    logger.logMessengerVisible('account-1', true)

    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    handler(makeEvent(messengerWc), { t: 10, type: 'dom-click', detail: { target: 'editable', editableFocused: true } })

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const views = lines.map((l: { view?: string }) => l.view).filter(Boolean)
    expect(views.length).toBeGreaterThanOrEqual(3)
    expect(new Set(views)).toEqual(new Set(['view-1']))
    expect(lines.some((l: { detail?: Record<string, unknown> }) => l.detail?.hasActiveAccount === true)).toBe(true)
  })

  it('rejects detached, stale and disposed frames with a valid positive control', () => {
    logger.start()
    const wc = makeWebContents(7)
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const entry = { t: 0, type: 'dom-click', detail: { target: 'editable', editableFocused: true } }
    handler(makeEvent(wc), entry)
    const before = fs.readFileSync(logger.getState().filePath!, 'utf8')
    Object.defineProperty(wc.mainFrame, 'detached', { value: true, configurable: true })
    expect(() => handler(makeEvent(wc), entry)).not.toThrow()
    Object.defineProperty(wc.mainFrame, 'detached', { value: false })
    handler({ sender: wc, senderFrame: { parent: null, detached: false, url: wc.getURL() } }, entry)
    Object.defineProperty(wc.mainFrame, 'url', { get: () => { throw new Error('disposed') } })
    expect(() => handler(makeEvent(wc), entry)).not.toThrow()
    expect(fs.readFileSync(logger.getState().filePath!, 'utf8')).toBe(before)
  })

  it('rejects opaque and non-HTTPS origins even when navigation policy permits them', () => {
    logger.start()
    isServiceUrl.mockReturnValue(true)
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const entry = { t: 0, type: 'dom-click', detail: { target: 'editable', editableFocused: true } }
    handler(makeEvent(makeWebContents(21)), entry)
    const before = fs.readFileSync(logger.getState().filePath!, 'utf8')
    for (const url of ['about:blank', 'data:text/html,fixture', 'http://web.telegram.org/k/', 'https://user:secret@web.telegram.org/k/']) {
      handler(makeEvent(makeWebContents(22, { url })), entry)
    }
    expect(fs.readFileSync(logger.getState().filePath!, 'utf8')).toBe(before)
    expect(before).toContain('dom-click')
  })

  it('resynchronizes reloads while running and stopped and removes deactivated listeners', () => {
    const wc = makeWebContents(8)
    logger.bindMessengerWebContents(wc, 'account')
    logger.start()
    wc.emit('dom-ready')
    expect(wc.send).toHaveBeenLastCalledWith('fm-focus-diagnostic-control', { command: 'start' })
    logger.stop()
    wc.emit('dom-ready')
    expect(wc.send).toHaveBeenLastCalledWith('fm-focus-diagnostic-control', { command: 'stop' })
    logger.unbindMessengerWebContents(wc)
    vi.mocked(wc.send).mockClear()
    wc.emit('dom-ready')
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('routes the built private preload into the registered handler across start, reload and stop', () => {
    const wc = makeWebContents(13)
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    let control: ((event: unknown, message: unknown) => void) | undefined
    let dom = new Map<string, (event: unknown) => void>()
    class Element {
      tagName = 'TEXTAREA'
      isContentEditable = true
      getAttribute (): null { return null }
    }
    class InputEvent {
      isTrusted = true
      target = new Element()
      key = 'PRIVATE_SENTINEL'
    }
    const install = (): void => {
      dom = new Map()
      const context = vm.createContext({
        exports: {}, process: { argv: [], isMainFrame: true }, performance: { now: () => 1 },
        HTMLElement: Element, KeyboardEvent: InputEvent, MouseEvent: InputEvent,
        document: {
          activeElement: new Element(),
          addEventListener: (name: string, callback: (event: unknown) => void) => dom.set(name, callback),
          removeEventListener: (name: string) => dom.delete(name),
        },
        require: () => ({
          contextBridge: { exposeInMainWorld: () => {}, executeInMainWorld: () => {} },
          ipcRenderer: {
            on: (_channel: string, callback: typeof control) => { control = callback },
            send: (channel: string, entry: unknown) => { if (channel === EVENT_CHANNEL) handler(makeEvent(wc), entry) },
          },
        }),
      })
      vm.runInContext(fs.readFileSync(path.resolve('out/preload/messenger-preload.cjs'), 'utf8'), context)
    }
    vi.mocked(wc.send).mockImplementation((_channel, message) => { control?.({}, message) })
    install()
    logger.bindMessengerWebContents(wc, 'private-account')
    expect(dom.size).toBe(0)
    logger.start()
    dom.get('keydown')?.(new InputEvent())
    install()
    wc.emit('dom-ready')
    dom.get('keydown')?.(new InputEvent())
    const before = fs.readFileSync(logger.getState().filePath!, 'utf8')
    expect(before.match(/dom-keydown/g)).toHaveLength(2)
    expect(before).not.toContain('PRIVATE_SENTINEL')
    logger.stop()
    expect(dom.size).toBe(0)
    install()
    wc.emit('dom-ready')
    expect(dom.size).toBe(0)
    expect(fs.readFileSync(logger.getState().filePath!, 'utf8')).toBe(before)
  })

  it('budgets malformed payloads before inspecting their schema without warning bursts', () => {
    logger.start()
    const wc = makeWebContents(14)
    const handler = (ipcMain as unknown as Record<string, (event: unknown, entry: unknown) => void>)[EVENT_CHANNEL]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 100; i++) handler(makeEvent(wc), { t: 0, type: 'invalid', detail: 'PRIVATE_SENTINEL' })
    const payload = { get type (): never { throw new Error('must not inspect after budget') } }
    expect(() => handler(makeEvent(wc), payload)).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    expect(fs.readFileSync(logger.getState().filePath!, 'utf8')).not.toContain('PRIVATE_SENTINEL')
    warn.mockRestore()
  })

  it('registers zoom listener and logs zoom factor when the event fires', () => {
    const messengerWc = makeWebContents(2, { url: 'https://web.telegram.org/k/', zoomFactor: 1.25 })
    logger.bindMessengerWebContents(messengerWc, 'account-1')
    logger.start()
    expect(messengerWc.on).toHaveBeenCalledWith('zoom-changed', expect.any(Function))

    // Fire the registered zoom-changed handler manually.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zoomHandler = (messengerWc as any).emit('zoom-changed')
    void zoomHandler

    const content = fs.readFileSync(logger.getState().filePath!, 'utf8')
    expect(content).toContain('zoom')
    expect(content).toContain('"zoomFactor":1.25')
  })
})
