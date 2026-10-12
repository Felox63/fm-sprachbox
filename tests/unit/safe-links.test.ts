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

import { shell, Menu, dialog } from 'electron'
import {
  isSafeExternalUrl,
  openTrustedExternalLink,
  attachSafeLinkContextMenu,
} from '../../src/main/safe-links.js'

interface FakeEvent {
  sender?: FakeWebContents
  senderFrame?: FakeWebFrameMain | null
  preventDefault: () => void
  defaultPrevented: boolean
}

interface FakeWebFrameMain {
  parent: FakeWebFrameMain | null
  url: string
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
  on: (event: string, cb: (event: FakeEvent, params: Record<string, unknown>) => void) => void
  listeners: Record<string, Array<(event: FakeEvent, params: Record<string, unknown>) => void>>
  emitContextMenu: (params: Record<string, unknown>) => FakeEvent
  emitIpcMessage: (channel: string, ...args: unknown[]) => FakeEvent
}

function makeFakeWebContents (url = 'https://web.whatsapp.com/'): FakeWebContents {
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
    emitContextMenu: (params) => {
      const event: FakeEvent = {
        preventDefault: () => { event.defaultPrevented = true },
        defaultPrevented: false,
      }
      const cbs = listeners['context-menu'] ?? []
      for (const cb of cbs) {
        cb(event, params)
      }
      return event
    },
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
  }
  return wc
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('isSafeExternalUrl', () => {
  it('allows plain http and https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/')).toBe(true)
    expect(isSafeExternalUrl('http://example.com/page')).toBe(true)
    expect(isSafeExternalUrl('https://example.com:8443/path?x=1')).toBe(true)
  })

  it('blocks non-http protocols', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,foo')).toBe(false)
    expect(isSafeExternalUrl('mailto:md@merkeldesign.biz')).toBe(false)
    expect(isSafeExternalUrl('custom-app://open')).toBe(false)
  })

  it('blocks URLs with embedded credentials', () => {
    expect(isSafeExternalUrl('https://user:pass@example.com/')).toBe(false)
    expect(isSafeExternalUrl('https://user@example.com/')).toBe(false)
  })

  it('blocks invalid or empty hostnames', () => {
    expect(isSafeExternalUrl('https://')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isSafeExternalUrl(null)).toBe(false)
    expect(isSafeExternalUrl(undefined)).toBe(false)
    expect(isSafeExternalUrl(123)).toBe(false)
    expect(isSafeExternalUrl({})).toBe(false)
  })

  it('rejects URLs beyond the configured length limit', () => {
    expect(isSafeExternalUrl('https://example.com/?token=' + 'x'.repeat(100000))).toBe(false)
    expect(isSafeExternalUrl('https://example.com/' + 'x'.repeat(4080))).toBe(false)
    expect(isSafeExternalUrl('https://example.com/' + 'x'.repeat(4080 - 20))).toBe(true)
  })
})

describe('openTrustedExternalLink', () => {
  it('opens safe http/https URLs', async () => {
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)
    expect(await openTrustedExternalLink('https://example.com/')).toBe(true)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('rejects unsafe URLs without calling openExternal', async () => {
    expect(await openTrustedExternalLink('file:///etc/passwd')).toBe(false)
    expect(await openTrustedExternalLink('https://user:pass@example.com/')).toBe(false)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('returns false when shell.openExternal rejects', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('no handler'))
    expect(await openTrustedExternalLink('https://example.com/')).toBe(false)
  })

  it('does not leak URL or token from the rejection error', async () => {
    const url = 'https://example.com/?token=review-secret'
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('Unable to open ' + url))
    await openTrustedExternalLink(url)
    const logged = spy.mock.calls.flat().map(String).join(' ')
    spy.mockRestore()
    expect(logged).not.toContain('review-secret')
    expect(logged).not.toContain('https://example.com')
    expect(logged).toContain('Failed to open external link')
  })
})

describe('attachSafeLinkContextMenu', () => {
  it('ignores context-menu events without a linkURL', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({ linkURL: '' })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('ignores unsafe schemes', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({ linkURL: 'javascript:alert(1)' })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('ignores URLs with embedded credentials', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({ linkURL: 'https://user:pass@example.com/' })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('ignores URLs that exceed the length limit', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({ linkURL: 'https://example.com/?token=' + 'x'.repeat(100000) })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('ignores service-origin links', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: (url) => url.startsWith('https://web.whatsapp.com'),
      isServiceOrigin: (origin) => origin === 'https://web.whatsapp.com',
    })
    const event = wc.emitContextMenu({ linkURL: 'https://web.whatsapp.com/chat' })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('shows a context menu for safe external links from the main frame on the service origin', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(event.defaultPrevented).toBe(true)
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1)
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]
    expect(template[0]).toMatchObject({ label: 'Im Browser öffnen' })
  })

  it('opens the browser when the user selects the action', async () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)

    await (template[0].click as () => void | Promise<void>)()

    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('does not open the same URL twice in rapid succession', async () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]
    let resolveFirst: (() => void) | null = null
    vi.mocked(shell.openExternal).mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve }))

    const first = (template[0].click as () => void | Promise<void>)()
    const second = (template[0].click as () => void | Promise<void>)()

    // Let the async click bodies reach shell.openExternal.
    await Promise.resolve()

    // Second click must be deduplicated; only one open should have started.
    expect(shell.openExternal).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await first
    await second

    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('blocks known autoloaded WhatsApp origins in the context-menu path', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })

    const pdfEvent = wc.emitContextMenu({
      linkURL: 'https://webtp.whatsapp.net/pdf-viewer/?locale=de_DE',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(pdfEvent.defaultPrevented).toBe(false)

    const flowsEvent = wc.emitContextMenu({
      linkURL: 'https://flows.whatsapp.net/flows/cache_management/',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(flowsEvent.defaultPrevented).toBe(false)

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('never logs the raw link URL', async () => {
    const wc = makeFakeWebContents()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('no handler'))
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    wc.emitContextMenu({
      linkURL: 'https://example.com/?token=secret123',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]

    await (template[0].click as () => void | Promise<void>)()

    const logged = spy.mock.calls.flat().map((arg) => String(arg))
    expect(logged.some((line) => line.includes('token=secret123'))).toBe(false)
    expect(logged.some((line) => line.includes('https://example.com'))).toBe(false)
    spy.mockRestore()
  })

  it('rejects a context menu from a subframe', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const subframe = { parent: wc.mainFrame, url: 'https://foreign.example/' }
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/',
      frame: subframe,
      pageURL: 'https://web.whatsapp.com/',
      frameURL: 'https://foreign.example/',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('rejects a context menu when the frame is null', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/',
      frame: null,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('rejects a context menu when the pageURL is not the service origin', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => origin === 'https://web.whatsapp.com',
    })
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/',
      frame: wc.mainFrame,
      pageURL: 'https://evil.example.com/',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('rejects a context menu when the live top-level URL navigated away', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => origin === 'https://web.whatsapp.com',
    })
    wc.setURL('https://evil.example.com/')
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('rejects a live frame URL that changed to a foreign origin independently of getURL', () => {
    const wc = makeFakeWebContents()
    const serviceOrigin = 'https://web.whatsapp.com'
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === serviceOrigin } catch { return false }
      },
    })
    // frame.url changes to a foreign origin, while getURL/pageURL still claim service.
    wc.mainFrame.url = 'https://foreign.example/'
    const event = wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    expect(event.defaultPrevented).toBe(false)
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('fails closed when a stale/disposed frame property throws', () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    Object.defineProperty(wc.mainFrame, 'url', { get: () => { throw new Error('Render frame was disposed') } })
    expect(() => wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })).not.toThrow()
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('fails closed when the WebContents is destroyed before the menu callback click', async () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, { isServiceUrl: () => false, isServiceOrigin: () => true })
    wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]

    wc.destroy()
    await (template[0].click as () => void | Promise<void>)()

    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not open browser if the menu is clicked after navigation away', async () => {
    const wc = makeFakeWebContents()
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try {
          return new URL(origin).origin === 'https://web.whatsapp.com'
        } catch {
          return false
        }
      },
    })
    wc.emitContextMenu({
      linkURL: 'https://example.com/article',
      frame: wc.mainFrame,
      pageURL: 'https://web.whatsapp.com/',
    })
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]

    wc.setURL('https://evil.example.com/')
    await (template[0].click as () => void | Promise<void>)()

    expect(shell.openExternal).not.toHaveBeenCalled()
  })
})

describe('safe link click bridge (Telegram fallback)', () => {
  it('ignores IPC messages on other channels', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('some-other-channel', { url: 'https://example.com/' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('ignores malformed payloads', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 123 })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'javascript:alert(1)' })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/?token=' + 'x'.repeat(100000) })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('shows a native confirmation dialog for a safe external link from the service origin', async () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    vi.mocked(shell.openExternal).mockResolvedValueOnce(undefined)
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article', title: 'Example' })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const call = vi.mocked(dialog.showMessageBox).mock.calls[0]
    expect(call[1]).toMatchObject({
      type: 'question',
      title: 'Externen Link öffnen',
      message: expect.stringContaining('example.com'),
    })
    expect(call[1]?.message).not.toContain('https://example.com/article')
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/article')
  })

  it('does not open browser when the user cancels the dialog', async () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 })
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects service-origin links in the click bridge', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: (url) => {
        try { return new URL(url).origin === 'https://web.telegram.org' } catch { return false }
      },
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://web.telegram.org/k/#@somechat' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects click bridge when the view navigated to a foreign origin', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.setURL('https://evil.example.com/')
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects click bridge when the WebContents is destroyed', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.destroy()
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('deduplicates rapid click bridge invocations for the same URL', async () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    let resolveFirst: (() => void) | null = null
    vi.mocked(dialog.showMessageBox).mockImplementation(() => new Promise((resolve) => {
      resolveFirst = () => resolve({ response: 0 })
    }))
    vi.mocked(shell.openExternal).mockImplementation(() => new Promise((_resolve) => {
      // never resolves in this test; openExternal is awaited inside confirmAndOpen
    }))
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    const first = wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    const second = wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    await Promise.resolve()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    resolveFirst?.()
    await first
    await second
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('never logs the raw link URL in the click bridge path', async () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { /* no-op */ })
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('no handler'))
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: true,
      isAccountActive: () => true,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/?token=secret123' })
    await Promise.resolve()
    const logged = spy.mock.calls.flat().map((arg) => String(arg))
    expect(logged.some((line) => line.includes('token=secret123'))).toBe(false)
    expect(logged.some((line) => line.includes('https://example.com'))).toBe(false)
    spy.mockRestore()
  })

  it('does not register the click bridge when enableClickBridge is false', () => {
    const wc = makeFakeWebContents('https://web.telegram.org/k/')
    attachSafeLinkContextMenu(wc as unknown as Electron.WebContents, {
      isServiceUrl: () => false,
      isServiceOrigin: (origin) => {
        try { return new URL(origin).origin === 'https://web.telegram.org' } catch { return false }
      },
      enableClickBridge: false,
    })
    wc.emitIpcMessage('fm-safe-link-bridge', { url: 'https://example.com/article' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })
})
