import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', async () => {
  return {
    shell: { openExternal: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
    Menu: {
      buildFromTemplate: vi.fn((template) => ({
        popup: vi.fn(),
        template,
      })),
    },
  }
})

import { shell, dialog } from 'electron'
import { attachSafeLinkContextMenu } from '../../src/main/safe-links.js'

interface FakeEvent {
  sender?: FakeWebContents
  senderFrame?: FakeWebFrameMain | null
  preventDefault: () => void
  defaultPrevented: boolean
}

interface FakeWebFrameMain {
  parent: FakeWebFrameMain | null
  url: string
  detached?: boolean
}

interface FakeWebContents {
  id: number
  url: string
  getURL: () => string
  setURL: (url: string) => void
  mainFrame: FakeWebFrameMain
  destroyed: boolean
  destroy: () => void
  isDestroyed: () => boolean
  on: (event: string, cb: (event: FakeEvent, ...args: unknown[]) => void) => void
  listeners: Record<string, Array<(event: FakeEvent, ...args: unknown[]) => void>>
  emitIpcMessage: (channel: string, ...args: unknown[]) => FakeEvent
  triggerDidStartNavigation?: (isMainFrame: boolean) => void
}

function makeFakeWebContents (url = 'https://web.telegram.org/k/'): FakeWebContents {
  const listeners: FakeWebContents['listeners'] = {}
  const mainFrame: FakeWebFrameMain = { parent: null, url }
  const wc: FakeWebContents = {
    id: 1,
    url,
    getURL: () => wc.url,
    setURL: (next) => {
      wc.url = next
      mainFrame.url = next
    },
    mainFrame,
    destroyed: false,
    destroy: () => { wc.destroyed = true },
    isDestroyed: () => wc.destroyed,
    on: (event, cb) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(cb)
    },
    listeners,
    emitIpcMessage: (channel, ...args) => {
      const event: FakeEvent = {
        sender: wc,
        senderFrame: wc.mainFrame,
        preventDefault: () => { event.defaultPrevented = true },
        defaultPrevented: false,
      }
      const cbs = listeners['ipc-message'] ?? []
      for (const cb of cbs) {
        cb(event, channel, ...args)
      }
      return event
    },
    triggerDidStartNavigation: (isMainFrame: boolean) => {
      const cbs = listeners['did-start-navigation'] ?? []
      for (const cb of cbs) {
        const navEvent: FakeEvent & { isMainFrame?: boolean } = {
          isMainFrame,
          preventDefault: () => { navEvent.defaultPrevented = true },
          defaultPrevented: false,
        }
        cb(navEvent)
      }
    },
  }
  // Allow the handler to read the live generation through the frame object shape.
  Object.defineProperty(mainFrame, 'detached', {
    get: () => wc.destroyed,
    configurable: true,
  })
  return wc
}

function attach (
  wc: FakeWebContents,
  activeRef: { current: boolean } = { current: true },
  parent: { isDestroyed: () => boolean } | null = null,
): void {
  attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
    isServiceUrl: (url: string) => {
      try { return new URL(url).origin === 'https://web.telegram.org' } catch { return false }
    },
    isServiceOrigin: (origin: string) => {
      try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
    },
    enableClickBridge: true,
    isAccountActive: () => activeRef.current,
    parentWindow: parent as unknown as Electron.BrowserWindow | null,
  })
}

beforeEach(() => {
  vi.mocked(dialog.showMessageBox).mockReset().mockResolvedValue({ response: 0 })
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

const validExternalUrl = 'https://example.com/article'

describe('Telegram click bridge production handler security regressions', () => {
  it('allows a safe external link from the exact main frame and service origin', async () => {
    const wc = makeFakeWebContents()
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)
    attach(wc)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith(validExternalUrl)
  })

  it('rejects when event.sender is not the registered WebContents', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    const foreignSender = { ...wc, id: 999 } as unknown as FakeWebContents
    const event: FakeEvent = {
      sender: foreignSender,
      senderFrame: wc.mainFrame,
      preventDefault: () => { event.defaultPrevented = true },
      defaultPrevented: false,
    }
    const cbs = wc.listeners['ipc-message'] ?? []
    for (const cb of cbs) cb(event, 'fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects when event.senderFrame is a child frame instead of the main frame', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    const subframe: FakeWebFrameMain = { parent: wc.mainFrame, url: 'https://web.telegram.org/k/' }
    const event: FakeEvent = {
      sender: wc,
      senderFrame: subframe,
      preventDefault: () => { event.defaultPrevented = true },
      defaultPrevented: false,
    }
    const cbs = wc.listeners['ipc-message'] ?? []
    for (const cb of cbs) cb(event, 'fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects when event.senderFrame is null', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    const event: FakeEvent = {
      sender: wc,
      senderFrame: null,
      preventDefault: () => { event.defaultPrevented = true },
      defaultPrevented: false,
    }
    const cbs = wc.listeners['ipc-message'] ?? []
    for (const cb of cbs) cb(event, 'fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects when the live main frame is detached', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    wc.mainFrame.parent = null
    wc.mainFrame.url = 'https://web.telegram.org/k/'
    // Preserve live frame identity and URL; isolate the detached guard.
    Object.defineProperty(wc.mainFrame, 'detached', { value: true, configurable: true })
    const event: FakeEvent = {
      sender: wc,
      senderFrame: wc.mainFrame,
      preventDefault: () => { event.defaultPrevented = true },
      defaultPrevented: false,
    }
    const cbs = wc.listeners['ipc-message'] ?? []
    for (const cb of cbs) cb(event, 'fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('fails closed when the WebContents getter throws before any trust decision', async () => {
    const wc = makeFakeWebContents()
    Object.defineProperty(wc, 'getURL', {
      get: () => () => { throw new Error('Render frame was disposed') },
      configurable: true,
    })
    attach(wc)
    expect(() => wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })).not.toThrow()
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects when the live frame URL is not on the service origin', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    wc.mainFrame.url = 'https://evil.example.com/'
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects before the async dialog when the account is disabled', async () => {
    const wc = makeFakeWebContents()
    const activeRef = { current: false }
    attach(wc, activeRef)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects before the async dialog when the account no longer exists', async () => {
    const wc = makeFakeWebContents()
    const activeRef = { current: true }
    attach(wc, activeRef)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    activeRef.current = false
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/other' })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects the open after async dialog when the account is disabled during confirmation', async () => {
    const wc = makeFakeWebContents()
    const activeRef = { current: true }
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      activeRef.current = false
      return { response: 0 }
    })
    attach(wc, activeRef, { isDestroyed: () => false })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects the open after async dialog when the page URL changed during confirmation', async () => {
    const wc = makeFakeWebContents()
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      wc.setURL('https://foreign.example/')
      return { response: 0 }
    })
    attach(wc, { current: true }, { isDestroyed: () => false })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    await Promise.resolve()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it.each([true, false])('checks navigation generation for mainFrame=%s', async (isMainFrame) => {
    const wc = makeFakeWebContents()
    const frame = wc.mainFrame
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      wc.triggerDidStartNavigation?.(isMainFrame)
      return { response: 0 }
    })
    attach(wc, { current: true }, { isDestroyed: () => false })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(wc.mainFrame).toBe(frame)
    expect(wc.getURL()).toBe('https://web.telegram.org/k/')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(shell.openExternal).toHaveBeenCalledTimes(isMainFrame ? 0 : 1)
  })

  it.each(['detached', 'disposed'])('rejects current frame %s after confirmation', async (state) => {
    const wc = makeFakeWebContents()
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      if (state === 'detached') Object.defineProperty(wc.mainFrame, 'detached', { value: true })
      else Object.defineProperty(wc.mainFrame, 'url', { get: () => { throw new Error('disposed') } })
      return { response: 0 }
    })
    attach(wc)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(wc.isDestroyed()).toBe(false)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects the open after async dialog when the WebContents is destroyed during confirmation', async () => {
    const wc = makeFakeWebContents()
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(async () => {
      wc.destroy()
      return { response: 0 }
    })
    attach(wc, { current: true }, { isDestroyed: () => false })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    await Promise.resolve()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects unsafe schemes and URLs with credentials', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'custom-app://open',
      'mailto:md@merkeldesign.biz',
      'https://user:pass@example.com/',
      'https://u:p@example.com/',
    ]) {
      wc.emitIpcMessage('fm-safe-link-bridge', { url })
    }
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects oversized URLs that exceed the bounded length', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/' + 'x'.repeat(4096) })
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('rejects service-internal and WhatsApp autoloaded URLs', async () => {
    const wc = makeFakeWebContents()
    attach(wc)
    for (const url of [
      'https://web.telegram.org/k/#@somechat',
      'https://web.telegram.org/',
      'https://webtp.whatsapp.net/pdf-viewer/',
      'https://flows.whatsapp.net/flows/cache_management/',
    ]) {
      wc.emitIpcMessage('fm-safe-link-bridge', { url })
    }
    await Promise.resolve()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('deduplicates pending invocations so the same URL cannot flood dialogs', async () => {
    const wc = makeFakeWebContents()
    let resolveFirst: ((value: { response: number }) => void) | null = null
    vi.mocked(dialog.showMessageBox).mockImplementation(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))
    attach(wc)
    const first = wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    const second = wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    resolveFirst?.({ response: 0 })
    expect(first.sender).toBe(wc)
    expect(second.sender).toBe(wc)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('handles dialog rejection without opening the browser or leaking the URL', async () => {
    const wc = makeFakeWebContents()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })
    vi.mocked(dialog.showMessageBox).mockRejectedValueOnce(new Error('Unable to open ' + validExternalUrl))
    attach(wc)
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    await Promise.resolve()
    expect(shell.openExternal).not.toHaveBeenCalled()
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain(validExternalUrl)
    expect(logged).not.toContain('https://example.com')
    spy.mockRestore()
  })

  it('recovers the guard after rejection so the next valid link can still open', async () => {
    const wc = makeFakeWebContents()
    vi.mocked(dialog.showMessageBox)
      .mockRejectedValueOnce(new Error('fixture rejection'))
      .mockResolvedValueOnce({ response: 0 })
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)
    attach(wc, { current: true })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: validExternalUrl })
    await Promise.resolve()
    await Promise.resolve()
    // Wait long enough for the finally/setTimeout guard release to run before
    // sending the next link.
    await new Promise((resolve) => setTimeout(resolve, 50))
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/recovered' })
    await Promise.resolve()
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/recovered')
  })
})
